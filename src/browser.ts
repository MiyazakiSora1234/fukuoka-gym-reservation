// ブラウザの起動。Lambda では @sparticuz/chromium、PC では Playwright 同梱の Chromium を使う
import type { Browser } from 'playwright-core';

export const onLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

export async function launchBrowser(): Promise<Browser> {
  if (onLambda) {
    const [{ chromium }, { default: sparticuz }] = await Promise.all([
      import('playwright-core'),
      import('@sparticuz/chromium'),
    ]);
    return chromium.launch({ executablePath: await sparticuz.executablePath(), args: sparticuz.args, headless: true });
  }
  const { chromium } = await import('playwright');
  return chromium.launch();
}
