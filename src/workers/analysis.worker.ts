/**
 * Web Worker for heavy computational tasks (clustering).
 * Runs O(n²) Jaccard clustering off the main thread.
 *
 * All core logic is imported from src/services/analysis-core.ts
 * to maintain a single source of truth.
 */

import {
  clusterNewsCore,
  type NewsItemCore,
  type ClusteredEventCore,
} from '@/services/analysis-core';

// Message types for worker communication
interface ClusterMessage {
  type: 'cluster';
  id: string;
  items: NewsItemCore[];
  sourceTiers: Record<string, number>;
}

interface ResetMessage {
  type: 'reset';
}

type WorkerMessage = ClusterMessage | ResetMessage;

interface ClusterResult {
  type: 'cluster-result';
  id: string;
  clusters: ClusteredEventCore[];
}

// Worker message handler
self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'cluster': {
      // Deserialize dates (they come as strings over postMessage)
      const items = message.items.map(item => ({
        ...item,
        pubDate: new Date(item.pubDate),
      }));

      const getSourceTier = (source: string): number => message.sourceTiers[source] ?? 4;
      const clusters = clusterNewsCore(items, getSourceTier);

      const result: ClusterResult = {
        type: 'cluster-result',
        id: message.id,
        clusters,
      };
      self.postMessage(result);
      break;
    }

    case 'reset': {
      break;
    }
  }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
