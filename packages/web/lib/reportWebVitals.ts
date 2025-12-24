import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

export function reportWebVitals(onPerfEntry?: (metric: Metric) => void) {
  if (onPerfEntry) {
    onCLS(onPerfEntry);
    onFCP(onPerfEntry);
    onINP(onPerfEntry);
    onLCP(onPerfEntry);
    onTTFB(onPerfEntry);
  }
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
