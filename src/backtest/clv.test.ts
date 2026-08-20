import { test } from "node:test";
import assert from "node:assert/strict";
import { computeClv, pickSideFromDeviation, computeCovered } from "./clv.js";

// This file exists because a sign-convention bug here is exactly the kind
// of thing that looks right on a quick read and is wrong in production --
// every case below was hand-derived from "who actually made money" before
// being written as code, not the other way around.

test("pickSideFromDeviation favors home when the model is more negative than the reference line", () => {
  const result = pickSideFromDeviation(-5, -3);
  assert.equal(result.pickSide, "home");
  assert.equal(result.edgePoints, 2);
});

test("pickSideFromDeviation favors away when the model is less negative than the reference line", () => {
  const result = pickSideFromDeviation(-1, -3);
  assert.equal(result.pickSide, "away");
  assert.equal(result.edgePoints, 2);
});

test("computeClv picks home and reports positive CLV when the line moves toward home after opening", () => {
  // opening -3, model -5 (model favors home more than the opening market did) -> pickSide home.
  // closing -6: an early home bettor's -3 is a better number than closing bettors get -> positive CLV.
  const result = computeClv({ modelSpreadHome: -5, openingSpreadHome: -3, closingSpreadHome: -6 });
  assert.equal(result.pickSide, "home");
  assert.equal(result.edgePoints, 2);
  assert.equal(result.clv, 3);
});

test("computeClv picks away and reports negative CLV when the line moves toward home after opening", () => {
  // opening -3, model -1 (model favors home less than opening did) -> pickSide away.
  const result = computeClv({ modelSpreadHome: -1, openingSpreadHome: -3, closingSpreadHome: -6 });
  assert.equal(result.pickSide, "away");
  assert.equal(result.clv, -3);
});

test("computeClv reports positive CLV for an away pick when the line moves toward away", () => {
  // opening -5, model -3 -> deviation = -5 - -3 = -2 < 0 -> pickSide away.
  // closing -3: line moved away from home (toward away) -> good for the early away bettor.
  const result = computeClv({ modelSpreadHome: -3, openingSpreadHome: -5, closingSpreadHome: -3 });
  assert.equal(result.pickSide, "away");
  assert.equal(result.clv, 2);
});

test("home covers a big win against a small home favorite", () => {
  assert.equal(computeCovered("home", 10, -3), true);
});

test("home fails to cover a win too small to beat the spread", () => {
  assert.equal(computeCovered("home", 1, -3), false);
});

test("away covers when home wins by less than the spread", () => {
  assert.equal(computeCovered("away", 1, -3), true);
});

test("an exact push returns null for either side", () => {
  assert.equal(computeCovered("home", 3, -3), null);
  assert.equal(computeCovered("away", 3, -3), null);
});

test("covers correctly when away is favored (positive home spread)", () => {
  assert.equal(computeCovered("away", -10, 4), true);
  assert.equal(computeCovered("home", -10, 4), false);
});
