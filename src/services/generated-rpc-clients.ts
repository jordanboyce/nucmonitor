import type { ClimateServiceClient as ClimateServiceClientInstance } from '@/generated/client/worldmonitor/climate/v1/service_client';
import type { EconomicServiceClient as EconomicServiceClientInstance } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { HealthServiceClient as HealthServiceClientInstance } from '@/generated/client/worldmonitor/health/v1/service_client';
import type { InfrastructureServiceClient as InfrastructureServiceClientInstance } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { MarketServiceClient as MarketServiceClientInstance } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { NaturalServiceClient as NaturalServiceClientInstance } from '@/generated/client/worldmonitor/natural/v1/service_client';
import type { NewsServiceClient as NewsServiceClientInstance } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { RadiationServiceClient as RadiationServiceClientInstance } from '@/generated/client/worldmonitor/radiation/v1/service_client';
import type { SeismologyServiceClient as SeismologyServiceClientInstance } from '@/generated/client/worldmonitor/seismology/v1/service_client';
import type { WebcamServiceClient as WebcamServiceClientInstance } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { WildfireServiceClient as WildfireServiceClientInstance } from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import type { MarketServiceClient as MarketServiceClientCtor } from '@/generated/client/worldmonitor/market/v1/service_client';

/** Derived from generated service client constructors so protoc-gen option drift fails typecheck. */
type RpcClientOptions = NonNullable<ConstructorParameters<typeof MarketServiceClientCtor>[1]>;
type RpcClientConstructor<T extends object> = new (baseURL: string, options?: RpcClientOptions) => T;
type RpcClientConstructorLoader<T extends object> = () => Promise<RpcClientConstructor<T>>;
/** Maps every public member that is not an async method to `never`, so `T extends AsyncMethodsOnly<T>` fails for it. */
type AsyncMethodsOnly<T> = { [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? T[K] : never };

export function createLazyRpcClientConstructor<T extends object & AsyncMethodsOnly<T>>(loadConstructor: RpcClientConstructorLoader<T>): RpcClientConstructor<T> {
  return function LazyRpcClient(baseURL: string, options?: RpcClientOptions): T {
    let clientPromise: Promise<T> | undefined;
    const getClient = () => {
      if (!clientPromise) {
        clientPromise = loadConstructor()
          .then((ClientCtor) => new ClientCtor(baseURL, options))
          .catch((error) => {
            clientPromise = undefined;
            throw error;
          });
      }
      return clientPromise;
    };

    // Every property read yields an invoker, because the real client is not
    // loaded yet. That is only sound when every public member of T is an async
    // method; a field or getter would read as a function here while its type
    // says string or boolean (#4550). The AsyncMethodsOnly constraint rejects
    // such clients at compile time. At runtime a bare read stays silent, so if
    // the loaded client still drifts from its type, invoking a non-method
    // rejects instead of resolving to the value.
    // `then` and `toJSON` stay undefined so await and JSON.stringify treat the
    // proxy as a plain object instead of calling an invoker.
    return new Proxy({}, {
      get(target, property, receiver) {
        if (property === 'then' || property === 'toJSON') return undefined;
        if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => getClient().then((client) => {
          const value = (client as Record<PropertyKey, unknown>)[property];
          if (typeof value !== 'function') {
            throw new TypeError(
              `Lazy RPC client: "${String(property)}" is not a method on the loaded client `
              + `(got ${value === null ? 'null' : typeof value}). Only async methods can be `
              + 'read through the lazy proxy; access the loaded instance for fields.',
            );
          }
          return value.apply(client, args);
        });
      },
    }) as T;
  } as unknown as RpcClientConstructor<T>;
}

export const ClimateServiceClient = createLazyRpcClientConstructor<ClimateServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/climate/v1/service_client');
  return module.ClimateServiceClient;
});

export const EconomicServiceClient = createLazyRpcClientConstructor<EconomicServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/economic/v1/service_client');
  return module.EconomicServiceClient;
});

export const HealthServiceClient = createLazyRpcClientConstructor<HealthServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/health/v1/service_client');
  return module.HealthServiceClient;
});

export const InfrastructureServiceClient = createLazyRpcClientConstructor<InfrastructureServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/infrastructure/v1/service_client');
  return module.InfrastructureServiceClient;
});

export const MarketServiceClient = createLazyRpcClientConstructor<MarketServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/market/v1/service_client');
  return module.MarketServiceClient;
});

export const NaturalServiceClient = createLazyRpcClientConstructor<NaturalServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/natural/v1/service_client');
  return module.NaturalServiceClient;
});

export const NewsServiceClient = createLazyRpcClientConstructor<NewsServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/news/v1/service_client');
  return module.NewsServiceClient;
});

export const RadiationServiceClient = createLazyRpcClientConstructor<RadiationServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/radiation/v1/service_client');
  return module.RadiationServiceClient;
});

export const SeismologyServiceClient = createLazyRpcClientConstructor<SeismologyServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/seismology/v1/service_client');
  return module.SeismologyServiceClient;
});

export const WebcamServiceClient = createLazyRpcClientConstructor<WebcamServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/webcam/v1/service_client');
  return module.WebcamServiceClient;
});

export const WildfireServiceClient = createLazyRpcClientConstructor<WildfireServiceClientInstance>(async () => {
  const module = await import('@/generated/client/worldmonitor/wildfire/v1/service_client');
  return module.WildfireServiceClient;
});
