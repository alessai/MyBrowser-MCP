// Test cases. `gt` is the data-gt of the control the phrase refers to.
// gt: null = the setting does not exist on the page (correct answer: decline).
// hidden: inside the closed "Advantage+ creative enhancements" section (readable,
// so verifying it is fine; clicking it needs the section expanded first).
// lazy: in the Tracking section, which renders only after it is scrolled into view.
// Phrasings are deliberately the agent's words, not the page's labels.

// E1 + E3: verify settings ("is X set to Y?") on adset.html.
export const VERIFY = [
  { phrase: 'Advantage+ campaign budget', expect: 'off', gt: 'campaign.adv_budget' },
  { phrase: 'Campaign budget optimisation (CBO)', expect: 'on', gt: 'campaign.adv_budget' },
  { phrase: 'A/B test', expect: 'off', gt: 'campaign.ab_test' },
  { phrase: 'Campaign spending limit', expect: 'off', gt: 'campaign.spending_limit' },
  { phrase: 'Campaign objective: Leads', expect: 'on', gt: 'campaign.objective.leads' },
  { phrase: 'Buying type', expect: 'Auction', gt: 'campaign.buying_type' },
  { phrase: 'Ad set name', expect: 'UAE - sellers - 25-65', gt: 'adset.name' },
  { phrase: 'Conversion location: Website', expect: 'on', gt: 'adset.conv.website' },
  { phrase: 'Performance goal', expect: 'Maximise number of conversions', gt: 'adset.performance_goal' },
  { phrase: 'Budget type (daily or lifetime)', expect: 'Daily budget', gt: 'adset.budget_type' },
  { phrase: 'Daily budget amount', expect: '20', gt: 'adset.budget_amount' },
  { phrase: 'Ad set start date', expect: '2026-11-03', gt: 'adset.start_date' },
  { phrase: 'End date is set', expect: 'off', gt: 'adset.end_date' },
  { phrase: 'Advantage+ audience', expect: 'off', gt: 'adset.adv_audience' },
  { phrase: 'Minimum age', expect: '25', gt: 'adset.age_min' },
  { phrase: 'Gender: women only', expect: 'on', gt: 'adset.gender.women' },
  { phrase: 'Advantage+ placements', expect: 'off', gt: 'placements.mode.advantage' },
  { phrase: 'Manual placements', expect: 'on', gt: 'placements.mode.manual' },
  { phrase: 'Devices', expect: 'All devices', gt: 'placements.devices' },
  { phrase: 'Audience Network placements', expect: 'off', gt: 'placements.platform.audience_network' },
  { phrase: 'Threads placements', expect: 'on', gt: 'placements.platform.threads' },
  { phrase: 'Instagram as a platform', expect: 'on', gt: 'placements.platform.instagram' },
  { phrase: 'Stories, Status and Reels placements', expect: 'off', gt: 'placements.stories_reels' },
  { phrase: 'Facebook Reels', expect: 'off', gt: 'placements.fb_reels' },
  { phrase: 'In-stream video ads', expect: 'off', gt: 'placements.instream' },
  { phrase: 'Ad name', expect: 'Hook 3 - competitor price', gt: 'ad.name' },
  { phrase: 'Instagram account used for the ad', expect: '@getsampo', gt: 'ad.instagram' },
  { phrase: 'Ad format: single image or video', expect: 'on', gt: 'ad.format.single' },
  { phrase: 'Multi-advertiser ads', expect: 'off', gt: 'ad.multi_advertiser' },
  { phrase: 'Headline', expect: 'Free price audit', gt: 'ad.headline' },
  { phrase: 'CTA button', expect: 'Learn more', gt: 'ad.cta' },
  { phrase: 'Destination website URL', expect: 'https://getsampo.com/audit', gt: 'ad.url' },
  { phrase: 'Arabic translation', expect: 'off', gt: 'ad.translate.arabic' },
  { phrase: 'Tagalog translation', expect: 'off', gt: 'ad.translate.tagalog' },
  { phrase: 'Music enhancement', expect: 'off', gt: 'ad.enh.music', hidden: true },
  { phrase: '3D animation enhancement', expect: 'off', gt: 'ad.enh.3d', hidden: true },
  { phrase: 'Meta Pixel', expect: 'Sampo Pixel', gt: 'tracking.pixel', lazy: true },
  { phrase: 'Website events tracking', expect: 'on', gt: 'tracking.website_events', lazy: true },
  { phrase: 'Dynamic creative', expect: 'on', gt: null },
  { phrase: 'Special ad category: housing', expect: 'on', gt: null },
  { phrase: 'Budget scheduling', expect: 'on', gt: null },
];

// E2: fill a whole form from one spec (the Jev-driven executor).
export const FILL = [
  { phrase: 'Campaign name', value: 'Sampo - Price audit - Hook 4', gt: 'campaign.name' },
  { phrase: 'Advantage+ campaign budget', value: 'off', gt: 'campaign.adv_budget' },
  { phrase: 'A/B test', value: 'on', gt: 'campaign.ab_test' },
  { phrase: 'Performance goal', value: 'landing page views', gt: 'adset.performance_goal', expectOption: 'Maximise number of landing page views' },
  { phrase: 'Daily budget amount', value: '35', gt: 'adset.budget_amount' },
  { phrase: 'Ad set start date', value: '2026-11-05', gt: 'adset.start_date' },
  { phrase: 'Maximum age', value: '55', gt: 'adset.age_max' },
  { phrase: 'Gender', value: 'Women', gt: 'adset.gender.women', radioValue: 'on' },
  { phrase: 'Audience Network placements', value: 'off', gt: 'placements.platform.audience_network' },
  { phrase: 'Threads placements', value: 'on', gt: 'placements.platform.threads' },
  { phrase: 'Facebook Reels', value: 'on', gt: 'placements.fb_reels' },
  { phrase: 'Ad name', value: 'Hook 4 - margin', gt: 'ad.name' },
  { phrase: 'Headline', value: 'See who undercuts you', gt: 'ad.headline' },
  { phrase: 'Call to action', value: 'Get a quote', gt: 'ad.cta', expectOption: 'Get quote' },
  { phrase: 'Arabic translation', value: 'on', gt: 'ad.translate.arabic' },
  { phrase: 'Tagalog translation', value: 'off', gt: 'ad.translate.tagalog' },
  { phrase: 'Website URL', value: 'https://getsampo.com/audit?h=4', gt: 'ad.url' },
  { phrase: 'URL parameters', value: 'utm_source=meta&utm_content=hook4', gt: 'tracking.url_params', lazy: true },
];

// E3: click targets that start below the fold on adset.html (viewport at top).
export const OFFSCREEN = [
  { phrase: 'the Manual placements option', gt: 'placements.mode.manual' },
  { phrase: 'the Threads checkbox', gt: 'placements.platform.threads' },
  { phrase: 'the call to action dropdown', gt: 'ad.cta' },
  { phrase: 'the Advanced preview button', gt: 'ad.advanced_preview' },
  { phrase: 'the button that removes the UAE location', gt: 'adset.location.remove_uae' },
  { phrase: 'the Instagram account selector', gt: 'ad.instagram' },
  { phrase: 'the website URL field', gt: 'ad.url' },
  { phrase: 'the Facebook Reels placement checkbox', gt: 'placements.fb_reels' },
  { phrase: 'the gender option for women', gt: 'adset.gender.women' },
  { phrase: 'the switch for Arabic translation', gt: 'ad.translate.arabic' },
  { phrase: 'the Advantage+ creative enhancements section', gt: null, gtAccept: ['summary'] },
  { phrase: 'the Save as draft button', gt: 'footer.save' }, // fixed footer: in view already
];

// E3b: targets in a 250-row campaigns table (about 1,250 elements).
export function campaignName(i) {
  const a = ['Ramadan', 'Eid', 'Black Friday', 'Q4', 'Summer', 'Back to school', 'White Friday', 'National Day', 'New Year', 'Spring'];
  const b = ['retargeting', 'lookalike', 'brand awareness', 'sale', 'leads', 'catalogue', 'video views', 'app installs', 'traffic', 'price audit'];
  const c = ['UAE', 'KSA', 'Oman', 'Qatar', 'Kuwait'];
  return `${a[i % 10]} ${b[Math.floor(i / 10) % 10]} - ${c[Math.floor(i / 100) % 5]} ${2024 + (i % 3)}`;
}
const T = (i, control, verb) => ({ phrase: `${verb} the "${campaignName(i)}" campaign`, gt: `row.${i}.${control}`, row: i });
export const TABLE = [
  T(37, 'toggle', 'the on/off switch for'),
  T(88, 'edit', 'the Edit button for'),
  T(142, 'duplicate', 'the Duplicate button for'),
  T(199, 'select', 'the row checkbox for'),
  T(233, 'link', 'the name link of'),
  T(61, 'toggle', 'the on/off switch for'),
  T(175, 'edit', 'the Edit button for'),
  T(249, 'duplicate', 'the Duplicate button for'),
  T(5, 'toggle', 'the on/off switch for'),
  T(120, 'select', 'the row checkbox for'),
];

// E4: conditions to wait for on upload.html.
export const WAIT = [
  { key: 'finished', question: 'Has the video finished uploading and processing?', truth: 'uploadFinishedAt' },
  { key: 'preview', question: 'Is the ad preview visible on the page?', truth: 'previewAt' },
  { key: 'error', question: 'Is an upload error currently shown for this video?', truth: 'errorAt' },
];
export const WAIT_RUNS = [4000, 5500, 7000, 8000, 9500];
