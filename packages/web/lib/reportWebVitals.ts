import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
import { track } from './analytics';

function sendToPostHog(metric: Metric) {
  track('web_vital', {
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    navigationType: metric.navigationType,
  });
}

export function reportWebVitals(onPerfEntry?: (metric: Metric) => void) {
  const handler = (metric: Metric) => {
    sendToPostHog(metric);
    onPerfEntry?.(metric);
  };
  onCLS(handler);
  onFCP(handler);
  onINP(handler);
  onLCP(handler);
  onTTFB(handler);
}

export function measurePageLoad() {
  const startTime = performance.now();

  return {
    measure: () => {
      const loadTime = performance.now() - startTime;
      return loadTime;
    },
    logMetrics: () => {
      reportWebVitals((metric) => {
        console.log(`[Web Vitals] ${metric.name}:`, metric.value);
      });

      const loadTime = performance.now() - startTime;
      console.log(`[Page Load] Time to Interactive: ${loadTime.toFixed(2)}ms (${(loadTime / 1000).toFixed(2)}s)`);

      if (performance.navigation) {
        console.log('[Performance] Navigation type:', performance.navigation.type);
      }

      const paintEntries = performance.getEntriesByType('paint');
      paintEntries.forEach((entry) => {
        console.log(`[Paint] ${entry.name}: ${entry.startTime.toFixed(2)}ms`);
      });
    }
  };
}
