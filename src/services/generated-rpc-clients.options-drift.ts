import type { MarketServiceClientOptions } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ClimateServiceClientOptions } from '@/generated/client/worldmonitor/climate/v1/service_client';
import type { EconomicServiceClientOptions } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { HealthServiceClientOptions } from '@/generated/client/worldmonitor/health/v1/service_client';
import type { InfrastructureServiceClientOptions } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { NaturalServiceClientOptions } from '@/generated/client/worldmonitor/natural/v1/service_client';
import type { NewsServiceClientOptions } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { RadiationServiceClientOptions } from '@/generated/client/worldmonitor/radiation/v1/service_client';
import type { SeismologyServiceClientOptions } from '@/generated/client/worldmonitor/seismology/v1/service_client';
import type { WebcamServiceClientOptions } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { WildfireServiceClientOptions } from '@/generated/client/worldmonitor/wildfire/v1/service_client';

type AssertOptionsMatch<Canonical, Candidate> = (<T>() => T extends Canonical ? 1 : 2) extends (<T>() => T extends Candidate ? 1 : 2)
  ? (<T>() => T extends Candidate ? 1 : 2) extends (<T>() => T extends Canonical ? 1 : 2)
    ? true
    : false
  : false;

type AssertAllOptionsMatch<Checks extends readonly true[]> = Checks;

type IntentionalOptionsDrift = { readonly __intentionalOptionsDrift: unique symbol };
type IntentionalOptionsMismatch = AssertOptionsMatch<
  MarketServiceClientOptions,
  MarketServiceClientOptions & IntentionalOptionsDrift
>;

// @ts-expect-error -- an intentional mismatch must fail the same constraint used by the real guard.
export type LazyRpcClientOptionsDriftGuardRejectsMismatch = AssertAllOptionsMatch<[IntentionalOptionsMismatch]>;

/** Compile-time guard: every lazy RPC client must share the same constructor options shape. */
export type LazyRpcClientOptionsDriftChecks = AssertAllOptionsMatch<[
  AssertOptionsMatch<MarketServiceClientOptions, ClimateServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, EconomicServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, HealthServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, InfrastructureServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, NaturalServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, NewsServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, RadiationServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, SeismologyServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, WebcamServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, WildfireServiceClientOptions>,
]>;

export type LazyRpcClientOptionsDriftChecksPass = LazyRpcClientOptionsDriftChecks[number];
