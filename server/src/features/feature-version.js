export const FEATURE_SCHEMA_VERSION = 'v1.4b-feature-schema-1';
export const FEATURE_SET_VERSION = 'v1.4b-unified-1';
export const FEATURE_ALGORITHM_VERSION = 'v1.4b-feature-engine-1';
export const SOURCE_DATASET_VERSION = 'v1.4a-server-schema-1';

export const FEATURE_NAMES = Object.freeze([
  'logReturn1','logReturn3','logReturn6','logReturn12','closeToEma5','closeToEma10','closeToEma20',
  'ema5Slope','ema10Slope','ema20Slope','highLowRange','candleBodyRatio','upperWickRatio','lowerWickRatio',
  'atr14','atrNormalized','realizedVolatility','volatilityRegime','rangeExpansionRatio',
  'volumeRatio20','volumeZScore','quoteVolumeRatio','takerBuyRatio','takerSellRatio','takerImbalance',
  'swingHigh','swingLow','distanceToSupportAtr','distanceToResistanceAtr','rangePosition','breakoutState','falseBreakoutRisk','structureState',
  'fundingRate','fundingRateZScore','openInterest','openInterestChange','openInterestChangeRatio','longShortRatio','longShortRatioZScore','takerBuySellRatio','derivativesAvailability',
  'btcReturn','btcTrendState','btcVolatility','ethBtcReturnSpread','ethBtcRollingCorrelation','btcConflictState',
  'trend15m','trend1h','trend4h','multiTimeframeAlignment','multiTimeframeConflict','strategicRegime'
]);

export const featureSetDefinition = Object.freeze({
  schemaVersion: FEATURE_SCHEMA_VERSION,
  featureSetVersion: FEATURE_SET_VERSION,
  algorithmVersion: FEATURE_ALGORITHM_VERSION,
  target: 'ETHUSDT_15M_DIRECTION',
  contextIntervals: ['1h','4h'],
  features: FEATURE_NAMES
});
