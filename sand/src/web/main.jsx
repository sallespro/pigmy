/**
 * Entry point: bind the store to the DOM through webjsx's applyDiff.
 *
 * There is no scheduler in webjsx, so renders are coalesced into an
 * animation frame here. A run can produce events faster than the display
 * refreshes, and diffing once per frame is both sufficient and cheap.
 */

import { applyDiff } from "webjsx";

import { App } from "./app.jsx";
import { createStore } from "./store.js";

const root = document.getElementById("root");

let queued = false;

/**
 * Keep each event stream pinned to the bottom while "follow" is on, but
 * never fight a user who has scrolled up to read something.
 */
function autoscroll(follow) {
  if (!follow) return;
  for (const el of document.querySelectorAll(".stream")) {
    el.scrollTop = el.scrollHeight;
  }
}

function render(state) {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    applyDiff(root, App({ state, actions }));
    autoscroll(state.follow);
  });
}

const store = createStore(render);

const actions = {
  start: (opts) => store.start(opts),
  stop: () => store.stop(),
  setFilter: (key, value) => store.setFilter(key, value),
  setFollow: (value) => store.setFollow(value),
};

render(store.state);
store.init();
