-- Lets the backtest report break results down by how much data backed
-- each prediction (games played -> narrower confidence), to test whether
-- restricting to "significant opinion" predictions (not just large
-- deviation-from-market, which the threshold sweep already covers) does
-- better than the model's full, unfiltered set of picks.
ALTER TABLE backtest_results ADD COLUMN confidence numeric;
