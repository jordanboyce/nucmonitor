import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  requiresRedistributableProviders,
} from '../server/_shared/provider-redistribution';
import {
  hasRedistributableProviderAttribution,
  isOpenSkyProvider,
} from '../shared/provider-redistribution';

function requestWith(headers: Record<string, string> = {}): Request {
  return new Request('https://worldmonitor.app/api/aviation/v1/track-aircraft', { headers });
}

describe('provider redistribution boundary', () => {
  it('keeps browser product sessions on the display-provider path', () => {
    assert.equal(requiresRedistributableProviders(undefined), false);
    assert.equal(requiresRedistributableProviders(requestWith()), false);
    assert.equal(requiresRedistributableProviders(requestWith({
      'X-WorldMonitor-Key': 'wms_browser-session',
    })), false);
  });

  it('requires redistributable providers for API keys', () => {
    assert.equal(requiresRedistributableProviders(requestWith({
      'X-WorldMonitor-Key': 'wm_operator-api-key',
    })), true);
    assert.equal(requiresRedistributableProviders(requestWith({
      'X-Api-Key': 'enterprise-api-key',
    })), true);
  });

  it('recognizes OpenSky provider labels without matching other providers', () => {
    assert.equal(isOpenSkyProvider('opensky'), true);
    assert.equal(isOpenSkyProvider('OpenSky Network'), true);
    assert.equal(isOpenSkyProvider('OpenSky-Network'), true);
    assert.equal(isOpenSkyProvider('opensky_network'), true);
    assert.equal(isOpenSkyProvider('wingbits'), false);
    assert.equal(isOpenSkyProvider(undefined), false);
  });

  it('fails closed when a derived snapshot has no redistributable attribution', () => {
    assert.equal(hasRedistributableProviderAttribution('wingbits'), true);
    assert.equal(hasRedistributableProviderAttribution('adsb.lol'), true);
    assert.equal(hasRedistributableProviderAttribution('OpenSky Network'), false);
    assert.equal(hasRedistributableProviderAttribution(''), false);
    assert.equal(hasRedistributableProviderAttribution(undefined), false);
  });
});
