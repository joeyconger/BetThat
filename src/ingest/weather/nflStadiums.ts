// Stadium coordinates + dome status, keyed by the same NFL team abbreviation
// used everywhere else (teamNames.ts). CFB stadium coordinates aren't
// included yet — CFBD's /venues endpoint has lat/lon per venue and is the
// natural next source for that, left as a follow-up (see README).
export interface StadiumLocation {
  lat: number;
  lon: number;
  isDome: boolean;
}

export const NFL_STADIUMS: Record<string, StadiumLocation> = {
  ARI: { lat: 33.5276, lon: -112.2626, isDome: true },
  ATL: { lat: 33.7554, lon: -84.4008, isDome: true },
  BAL: { lat: 39.278, lon: -76.6227, isDome: false },
  BUF: { lat: 42.7738, lon: -78.787, isDome: false },
  CAR: { lat: 35.2258, lon: -80.8528, isDome: false },
  CHI: { lat: 41.8623, lon: -87.6167, isDome: false },
  CIN: { lat: 39.0955, lon: -84.516, isDome: false },
  CLE: { lat: 41.5061, lon: -81.6995, isDome: false },
  DAL: { lat: 32.7473, lon: -97.0945, isDome: true },
  DEN: { lat: 39.7439, lon: -105.02, isDome: false },
  DET: { lat: 42.34, lon: -83.0456, isDome: true },
  GB: { lat: 44.5013, lon: -88.0622, isDome: false },
  HOU: { lat: 29.6847, lon: -95.4107, isDome: true },
  IND: { lat: 39.7601, lon: -86.1639, isDome: true },
  JAX: { lat: 30.3239, lon: -81.6373, isDome: false },
  KC: { lat: 39.0489, lon: -94.4839, isDome: false },
  LA: { lat: 33.9535, lon: -118.3392, isDome: true },
  LAR: { lat: 33.9535, lon: -118.3392, isDome: true },
  LAC: { lat: 33.9535, lon: -118.3392, isDome: true },
  LV: { lat: 36.0909, lon: -115.1833, isDome: true },
  MIA: { lat: 25.958, lon: -80.2389, isDome: false },
  MIN: { lat: 44.9736, lon: -93.258, isDome: true },
  NE: { lat: 42.0909, lon: -71.2643, isDome: false },
  NO: { lat: 29.9511, lon: -90.0812, isDome: true },
  NYG: { lat: 40.8135, lon: -74.0745, isDome: false },
  NYJ: { lat: 40.8135, lon: -74.0745, isDome: false },
  PHI: { lat: 39.9008, lon: -75.1675, isDome: false },
  PIT: { lat: 40.4468, lon: -80.0158, isDome: false },
  SEA: { lat: 47.5952, lon: -122.3316, isDome: false },
  SF: { lat: 37.713, lon: -122.3862, isDome: false },
  TB: { lat: 27.9759, lon: -82.5033, isDome: false },
  TEN: { lat: 36.1665, lon: -86.7713, isDome: false },
  WAS: { lat: 38.9076, lon: -76.8645, isDome: false },
};
