const PLAN_IDS = ['free', 'golden', 'platinum', 'premium'];

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceLabel: '$0',
    dailyImageLimit: 50,
    dailyVideoLimit: 50
  },
  golden: {
    id: 'golden',
    name: 'Golden',
    priceLabel: '$3/month',
    dailyImageLimit: 300,
    dailyVideoLimit: 200
  },
  platinum: {
    id: 'platinum',
    name: 'Platinum',
    priceLabel: '$4/month',
    dailyImageLimit: 400,
    dailyVideoLimit: 300
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    priceLabel: '$10/month',
    dailyImageLimit: Number.POSITIVE_INFINITY,
    dailyVideoLimit: Number.POSITIVE_INFINITY
  }
};

function getPlan(planId) {
  return PLANS[String(planId || '').toLowerCase()] || PLANS.free;
}

function isValidPlan(planId) {
  return PLAN_IDS.includes(String(planId || '').toLowerCase());
}

function formatLimit(limit) {
  return Number.isFinite(limit) ? String(limit) : 'Unlimited';
}

function limitFor(planId, mediaType) {
  const plan = getPlan(planId);
  return mediaType === 'image' ? plan.dailyImageLimit : plan.dailyVideoLimit;
}

module.exports = {
  PLAN_IDS,
  PLANS,
  formatLimit,
  getPlan,
  isValidPlan,
  limitFor
};
