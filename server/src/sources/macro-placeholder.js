export class MacroSourceAdapter {
  constructor() { this.status = 'UNAVAILABLE'; }
  async collect() { return { ok: false, status: 'UNAVAILABLE', reason: 'NO_FROZEN_OFFICIAL_KEYLESS_SOURCE' }; }
}
