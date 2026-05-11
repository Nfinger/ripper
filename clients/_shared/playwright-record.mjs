#!/usr/bin/env node
/**
 * Playwright video recorder for Symphony agent workers.
 *
 * Usage:  node playwright-record.mjs <config.json>
 *
 * The Playwright MCP doesn't expose video recording, so the worker writes a
 * short config file describing the demo and invokes this script through the
 * Bash tool. The script launches Chromium with `recordVideo` enabled, runs a
 * sequence of navigate/click/fill/wait/scroll actions, and closes the context
 * which flushes the .webm to disk.
 *
 * Config schema (see `playwright-record.example.json` for a full example):
 *   {
 *     "url": "http://localhost:3000/feature",          // required
 *     "viewport": [1280, 720],                         // optional
 *     "output": ".symphony/artifacts/demo.webm",       // optional, default below
 *     "default_wait_ms": 600,                          // pause between steps
 *     "steps": [
 *       { "type": "wait", "ms": 1500 },
 *       { "type": "click", "selector": "[data-testid=open]" },
 *       { "type": "fill", "selector": "input[name=email]", "value": "x@y.z" },
 *       { "type": "press", "selector": "input", "key": "Enter" },
 *       { "type": "scroll", "y": 300 },
 *       { "type": "screenshot", "path": ".symphony/artifacts/01-home.png" }
 *     ]
 *   }
 *
 * Exit codes: 0 ok, 1 config/usage error, 2 recording error.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exit } from 'node:process';

function fail(code, msg) {
  process.stderr.write(`[record] ${msg}\n`);
  exit(code);
}

const configPath = process.argv[2];
if (!configPath) fail(1, 'usage: playwright-record.mjs <config.json>');

let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  fail(1, `cannot read/parse ${configPath}: ${err.message}`);
}

const url = cfg.url;
if (!url) fail(1, 'config.url is required');
const [vw, vh] = Array.isArray(cfg.viewport) && cfg.viewport.length === 2 ? cfg.viewport : [1280, 720];
const output = resolve(cfg.output ?? '.symphony/artifacts/demo.webm');
const videoDir = dirname(output);
mkdirSync(videoDir, { recursive: true });
const defaultWaitMs = Number.isFinite(cfg.default_wait_ms) ? cfg.default_wait_ms : 500;
const steps = Array.isArray(cfg.steps) ? cfg.steps : [];

let browser;
try {
  browser = await chromium.launch({ headless: cfg.headless !== false });
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    recordVideo: { dir: videoDir, size: { width: vw, height: vh } },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(cfg.navigation_timeout_ms ?? 30_000);
  page.setDefaultTimeout(cfg.action_timeout_ms ?? 10_000);

  await page.goto(url, { waitUntil: 'load' });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] ?? {};
    process.stderr.write(`[record] step ${i + 1}/${steps.length}: ${step.type}\n`);
    try {
      switch (step.type) {
        case 'wait':
          await page.waitForTimeout(Math.max(0, Number(step.ms ?? 1000)));
          break;
        case 'navigate':
          await page.goto(step.url, { waitUntil: step.wait_until ?? 'load' });
          break;
        case 'click':
          await page.click(step.selector);
          break;
        case 'fill':
          await page.fill(step.selector, String(step.value ?? ''));
          break;
        case 'press':
          await page.press(step.selector ?? 'body', step.key);
          break;
        case 'hover':
          await page.hover(step.selector);
          break;
        case 'scroll':
          await page.evaluate(([x, y]) => window.scrollBy(x, y), [Number(step.x ?? 0), Number(step.y ?? 0)]);
          break;
        case 'screenshot': {
          const sp = resolve(step.path ?? `.symphony/artifacts/screenshot-${Date.now()}.png`);
          mkdirSync(dirname(sp), { recursive: true });
          await page.screenshot({ path: sp, fullPage: Boolean(step.full_page) });
          break;
        }
        case 'wait_for':
          await page.waitForSelector(step.selector, { state: step.state ?? 'visible' });
          break;
        default:
          process.stderr.write(`[record] unknown step type: ${step.type}\n`);
      }
    } catch (err) {
      process.stderr.write(`[record] step ${i + 1} failed: ${err.message}\n`);
      // Continue — partial recording is still useful proof.
    }
    if (defaultWaitMs > 0) await page.waitForTimeout(defaultWaitMs);
  }

  // Force a final flush; close the context to finalize the video file.
  const video = page.video();
  await page.close();
  await context.close();

  if (video) {
    const generated = await video.path();
    try {
      renameSync(generated, output);
      const sz = statSync(output).size;
      process.stderr.write(`[record] saved ${output} (${sz} bytes)\n`);
    } catch (err) {
      process.stderr.write(`[record] could not rename ${generated} → ${output}: ${err.message}\n`);
    }
  } else {
    process.stderr.write('[record] page.video() returned null; no recording captured\n');
  }
} catch (err) {
  process.stderr.write(`[record] fatal: ${err.message}\n`);
  if (browser) await browser.close().catch(() => {});
  exit(2);
} finally {
  if (browser) await browser.close().catch(() => {});
}
