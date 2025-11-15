import { beforeEach, afterEach } from 'vitest';

const unhandledRejections: Array<{ error: any; promise: Promise<any> }> = [];

if (typeof process !== 'undefined') {
  // Node.js environment
  process.on('unhandledRejection', (reason, promise) => {
    console.error('🔴 Unhandled Rejection detected:');
    console.error('  Reason:', reason);
    console.error('  Stack:', reason instanceof Error ? reason.stack : 'N/A');
    unhandledRejections.push({ error: reason, promise });
  });
}

if (typeof window !== 'undefined') {
  // Browser environment
  window.addEventListener('unhandledrejection', (event) => {
    console.error('🔴 Unhandled Rejection detected:');
    console.error('  Reason:', event.reason);
    console.error('  Stack:', event.reason instanceof Error ? event.reason.stack : 'N/A');
    unhandledRejections.push({ error: event.reason, promise: event.promise });
  });
}

// Clear rejections before each test
beforeEach(() => {
  unhandledRejections.length = 0;
});

// Log any unhandled rejections after each test
afterEach(() => {
  if (unhandledRejections.length > 0) {
    console.warn(`⚠️  Test had ${unhandledRejections.length} unhandled rejection(s)`);
    unhandledRejections.forEach(({ error }, index) => {
      console.warn(`  ${index + 1}. ${error}`);
    });
  }
});

