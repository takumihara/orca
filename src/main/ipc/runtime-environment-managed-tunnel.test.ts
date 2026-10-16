import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  environments: {} as Record<string, Record<string, unknown>>,
  ensureForRuntimeCall: vi.fn(async () => {}),
  hasWslService: true,
  ensureTunnel: vi.fn(async () => {}),
  rebuildTunnel: vi.fn(async () => {}),
  verify: vi.fn(),
  restoreUpdate: vi.fn(() => null),
  redeploy: vi.fn(async () => true)
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userData: string, id: string) =>
    mocks.environments[id] ?? { id, orcadDeployment: { sshTargetId: 'ssh-1' } }
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () =>
    mocks.hasWslService ? { ensureForRuntimeCall: mocks.ensureForRuntimeCall } : null
}))
vi.mock('../ssh/managed-server-update-deps', () => ({ managedServerUpdateDeps: () => ({}) }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  rebuildOrcadManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('../ssh/orcad-managed-serving-verify', () => ({
  verifyOrcadManagedServing: mocks.verify
}))
vi.mock('../ssh/orcad-managed-update-on-restore', () => ({
  updateManagedOrcadOnRestore: mocks.restoreUpdate,
  redeployStoppedManagedOrcad: mocks.redeploy
}))
vi.mock('../ssh/ssh-host-server-status', () => ({ setSshHostServerStatus: vi.fn() }))
vi.mock('../ssh/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => null }))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: null, getCurrentMainWindow: () => null }))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastSshState: vi.fn() }))

import { MANAGED_ORCAD_NOT_ACTIVATED_DETAIL } from '../ssh/orcad-managed-serving'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { WSL_HOSTS_GATED_OFF_MESSAGE } from '../wsl/wsl-host-gate'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'

describe('resolving a managed runtime for a call', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redeploys, before the call, a server another desktop stopped mid-session', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).toHaveBeenCalledWith('env-1', expect.any(Function))
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
    // The forward is rebuilt for the port the redeployed server bound, not reused.
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('leaves a serving server to the once-per-session update check', async () => {
    mocks.verify.mockResolvedValue({ state: 'serving' })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('env-1', expect.any(Function))
  })
})

describe('resolving a runtime for a call, by host kind', () => {
  const wsl = {
    id: 'wsl:ubuntu',
    orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasWslService = true
    mocks.environments = { 'wsl:ubuntu': wsl, 'paired-1': { id: 'paired-1' } }
    mocks.verify.mockResolvedValue({ state: 'serving' })
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('brings a WSL host up through its service, never through an SSH tunnel', async () => {
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).resolves.toEqual(wsl)
    expect(mocks.ensureForRuntimeCall).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
  })

  it('resolves a WSL host with no service without bringing anything up', async () => {
    mocks.hasWslService = false
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).resolves.toEqual(wsl)
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
  })

  it('refuses a WSL host with the gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).rejects.toThrow(
      WSL_HOSTS_GATED_OFF_MESSAGE
    )
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it('runs the managed tunnel path for a paired server too', async () => {
    await expect(resolveManagedRuntimeEnvironment('/u', 'paired-1')).resolves.toEqual({
      id: 'paired-1'
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.verify).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('paired-1', expect.any(Function))
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })
})
