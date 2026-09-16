import type { AgentRuntimeAdapter, RuntimeDetection } from './types.js';

/** An adapter owns enumeration and probing. The host/UI never infers a provider from a name. */
export interface LocalAgentCandidate {
  discoveryId: string;
  profile: string;
  /** What the runtime itself calls this profile, if anything. Presentation only. */
  displayName?: string | null;
  adapter: AgentRuntimeAdapter;
}
export interface AgentDiscoveryProvider {
  id: string;
  discover(): Promise<LocalAgentCandidate[]>;
}
export interface DiscoveredAgent {
  candidate: LocalAgentCandidate;
  detection: RuntimeDetection;
}
export class AgentDiscovery {
  private candidates = new Map<string, LocalAgentCandidate>();
  constructor(private readonly providers: AgentDiscoveryProvider[]) {}
  async scan(): Promise<DiscoveredAgent[]> {
    const groups = await Promise.all(this.providers.map(provider => provider.discover()));
    const next = new Map<string, LocalAgentCandidate>();
    const candidates = groups.flat();
    for (const candidate of candidates) {
      if (next.has(candidate.discoveryId)) throw new Error('Duplicate discovered agent identifier');
      next.set(candidate.discoveryId, candidate);
    }
    const found = (await Promise.all(candidates.map(async candidate => {
      const detection = await candidate.adapter.detect();
      return detection.available ? { candidate, detection } : null;
    }))).filter((item): item is DiscoveredAgent => item !== null);
    this.candidates = next;
    return found;
  }
  async select(discoveryId: string): Promise<DiscoveredAgent> {
    const candidate = this.candidates.get(discoveryId);
    if (!candidate) throw new Error('This agent is no longer in the discovery results. Scan again.');
    const detection = await candidate.adapter.detect();
    if (detection.readiness !== 'ready') throw new Error(detection.reason ?? 'This agent is not ready.');
    return { candidate, detection };
  }
}
