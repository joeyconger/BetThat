-- precipitation_probability only makes sense for a forecast (a % chance);
-- Open-Meteo's historical archive API reports what actually happened
-- instead (an amount), so historical rows populate precipitation_actual
-- and leave precipitation_probability null, and vice versa for
-- forecast-based (upcoming-game) rows.
ALTER TABLE weather ADD COLUMN precipitation_actual numeric;
