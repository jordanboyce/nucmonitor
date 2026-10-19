import type {
  GetChinaActivityNowcastRequest,
  GetChinaActivityNowcastResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import {
  CHINA_ACTIVITY_NOWCAST_METHOD_VERSION,
  evaluateChinaActivityNowcast,
  isChinaActivityNowcastUpstreamUnavailable,
  type ChinaActivityNowcastResponse,
} from '../../../../shared/china-activity-nowcast';

// NucMonitor retired the China corridor control towers (supply-chain domain)
// that fed this nowcast. The economic service contract still declares the
// method, so it answers with the insufficient-evidence shape the client
// already treats as "upstream unavailable" instead of a dangling import.
export function projectChinaActivityNowcastWireResponse(
  response: ChinaActivityNowcastResponse,
): GetChinaActivityNowcastResponse {
  return {
    generatedAt: response.evaluatedAt,
    methodVersion: response.methodVersion,
    comparisonState: response.state,
    upstreamUnavailable: isChinaActivityNowcastUpstreamUnavailable(response),
    payloadJson: JSON.stringify(response),
  };
}

export async function getChinaActivityNowcast(
  _ctx: ServerContext,
  _req: GetChinaActivityNowcastRequest,
): Promise<GetChinaActivityNowcastResponse> {
  const evaluatedAt = new Date().toISOString();
  return projectChinaActivityNowcastWireResponse(
    evaluateChinaActivityNowcast({
      evaluatedAt,
      officialObservations: [],
      proxyObservations: [],
    }),
  );
}

export { CHINA_ACTIVITY_NOWCAST_METHOD_VERSION };
