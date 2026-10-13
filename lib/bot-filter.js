'use strict';

/**
 * Bot filter for first-party funnel events (2026-10-13).
 *
 * Crawlers, ad reviewers and headless browsers run the page's JavaScript and
 * used to land in estimator_events as page views — about 17% of them (Meta ad
 * review, Exa, Bing, DuckDuckGo, HeadlessChrome). That inflated the funnel's
 * top and made Step 1 look worse than it was. Matched against every distinct
 * UA in estimator_events on 2026-10-13: 112 bot sessions caught, zero of the
 * sessions that went on to complete Step 1.
 */

const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|meta-external|facebookexternalhit|google web preview|python-|curl\/|wget|httpclient|phantomjs|puppeteer|playwright/i;

// ua: the request's User-Agent. clientFlag: navigator.webdriver from the page.
function isBot(ua, clientFlag) {
  if (clientFlag === true) return true;
  if (!ua) return true;
  return BOT_UA.test(String(ua));
}

module.exports = { isBot, BOT_UA };
