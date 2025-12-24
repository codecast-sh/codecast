#!/usr/bin/env node

const puppeteer = require('puppeteer');

async function measureDashboardPerformance(url = 'http://localhost:3000/dashboard') {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const metrics = {
    navigationStart: 0,
    domContentLoaded: 0,
    loadComplete: 0,
    firstPaint: 0,
    firstContentfulPaint: 0,
    largestContentfulPaint: 0,
    timeToInteractive: 0,
  };

  page.on('load', async () => {
    const performanceMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByType('paint');

      const fcp = paint.find(entry => entry.name === 'first-contentful-paint');

      return {
        domContentLoaded: navigation.domContentLoadedEventEnd - navigation.fetchStart,
        loadComplete: navigation.loadEventEnd - navigation.fetchStart,
        firstContentfulPaint: fcp ? fcp.startTime : 0,
      };
    });

    Object.assign(metrics, performanceMetrics);
  });

  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  await page.waitForTimeout(2000);

  const webVitals = await page.evaluate(() => {
    return new Promise((resolve) => {
      import('web-vitals').then(({ onLCP, onFCP, onCLS, onINP, onTTFB }) => {
        const vitals = {};

        onLCP((metric) => { vitals.lcp = metric.value; });
        onFCP((metric) => { vitals.fcp = metric.value; });
        onCLS((metric) => { vitals.cls = metric.value; });
        onINP((metric) => { vitals.inp = metric.value; });
        onTTFB((metric) => { vitals.ttfb = metric.value; });

        setTimeout(() => resolve(vitals), 1000);
      });
    });
  });

  await browser.close();

  console.log('\n📊 Dashboard Performance Metrics\n');
  console.log('Core Web Vitals:');
  console.log(`  LCP (Largest Contentful Paint): ${webVitals.lcp?.toFixed(2)}ms`);
  console.log(`  FCP (First Contentful Paint):   ${webVitals.fcp?.toFixed(2)}ms`);
  console.log(`  CLS (Cumulative Layout Shift):  ${webVitals.cls?.toFixed(4)}`);
  console.log(`  INP (Interaction to Next Paint): ${webVitals.inp?.toFixed(2)}ms`);
  console.log(`  TTFB (Time to First Byte):       ${webVitals.ttfb?.toFixed(2)}ms`);

  console.log('\nNavigation Timing:');
  console.log(`  DOM Content Loaded: ${metrics.domContentLoaded?.toFixed(2)}ms`);
  console.log(`  Load Complete:      ${metrics.loadComplete?.toFixed(2)}ms`);

  const tti = Math.max(
    webVitals.lcp || 0,
    metrics.domContentLoaded || 0
  );

  console.log(`\n⏱️  Time to Interactive: ${tti.toFixed(2)}ms (${(tti / 1000).toFixed(2)}s)`);

  const target = 2000;
  const status = tti < target ? '✅ PASS' : '❌ FAIL';
  console.log(`\nTarget: < ${target}ms`);
  console.log(`Status: ${status}\n`);

  process.exit(tti < target ? 0 : 1);
}

const url = process.argv[2] || 'http://localhost:3000/dashboard';
measureDashboardPerformance(url).catch((error) => {
  console.error('Error measuring performance:', error);
  process.exit(1);
});
