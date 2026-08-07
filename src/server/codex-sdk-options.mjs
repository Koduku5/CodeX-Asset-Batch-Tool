export const createCodexSdkOptions = () => ({
  config: {
    suppress_unstable_features_warning: true,
    features: {
      respect_system_proxy: true
    }
  }
});
