export interface PricingPlan {
  name: string;
  priceLg: string;
  priceSub?: string;
  desc?: string;
  badge?: string;
  featured?: boolean;
  cta: string;
}

export type PricingFeatureValue = string | boolean;

export interface PricingFeature {
  label: string;
  values: PricingFeatureValue[];
}
