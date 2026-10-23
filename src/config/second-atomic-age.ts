// The Second Atomic Age (thesecondatomicage.com): an independent,
// non-commercial index of the US advanced-nuclear buildout — trackers for the
// DOE reactor pilot program, commercialization, the Army's Janus microreactor
// program and fusion; explorers for sited projects, the order book and the
// fuel-cycle supply chain; and company and reactor reference tables.
//
// Its terms (About & methodology, October 2026) welcome linking and quoting
// with attribution but forbid republishing or bulk-extracting the dataset
// without written permission. NucMonitor therefore keeps a curated index of
// deep links here and never fetches their JSON. If a data licence is agreed,
// the Advanced Nuclear Buildout panel is where live rows would go.
//
// Pure data module: no imports, so config, components, tests and docs can all
// read it.

export const SECOND_ATOMIC_AGE = {
  name: 'The Second Atomic Age',
  home: 'https://thesecondatomicage.com/',
  about: 'https://thesecondatomicage.com/about/',
  /** Dated changelog of material changes, surfaced on their home page. */
  updates: 'https://thesecondatomicage.com/#updates',
  corrections: 'corrections@thesecondatomicage.com',
  /** Date NucMonitor last reviewed the index below against the live site. */
  reviewed: '2026-10-22',
} as const;

export type SecondAtomicAgeToolKind = 'tracker' | 'explorer' | 'reference' | 'calculator';

export const SECOND_ATOMIC_AGE_KIND_LABELS: Record<SecondAtomicAgeToolKind, string> = {
  tracker: 'Tracker',
  explorer: 'Explorer',
  reference: 'Reference',
  calculator: 'Calculator',
};

export interface SecondAtomicAgeTool {
  id: string;
  kind: SecondAtomicAgeToolKind;
  title: string;
  url: string;
  /** NucMonitor's own one-line description of what the tool answers. */
  summary: string;
  /** Registry categories the tool is most relevant to, for per-facility links. */
  categories?: ReadonlyArray<'new-build' | 'fuel-cycle' | 'doe-site'>;
}

export const SECOND_ATOMIC_AGE_TOOLS: readonly SecondAtomicAgeTool[] = [
  {
    id: 'criticality', kind: 'tracker', title: 'Race to Criticality',
    url: 'https://thesecondatomicage.com/criticality/',
    summary: 'Which DOE pilot-program reactors have reached first criticality, which are building, and the milestone each is on.',
    categories: ['new-build', 'doe-site'],
  },
  {
    id: 'criticality-to-commercial', kind: 'tracker', title: 'From Criticality to Commercial Operation',
    url: 'https://thesecondatomicage.com/criticality-to-commercial/',
    summary: 'The machines racing from a critical core to a paying load, and which of them have gone critical before.',
    categories: ['new-build'],
  },
  {
    id: 'commercialization', kind: 'tracker', title: 'Race to Commercialization',
    url: 'https://thesecondatomicage.com/commercialization/',
    summary: 'Where each advanced-reactor design stands on the path from demonstration to deployment.',
    categories: ['new-build'],
  },
  {
    id: 'roadmap', kind: 'tracker', title: 'Roadmap to Commercial-Scale Demo',
    url: 'https://thesecondatomicage.com/roadmap/',
    summary: 'What a full-size, full-fuel, whole-plant demonstration requires and what each machine on the way proves.',
    categories: ['new-build'],
  },
  {
    id: 'janus', kind: 'tracker', title: 'The Janus Program',
    url: 'https://thesecondatomicage.com/janus/',
    summary: 'The military\'s September 2028 deadline to run a reactor on a domestic base: six installations against the clock.',
  },
  {
    id: 'fusion-power', kind: 'tracker', title: 'Race to Fusion Power',
    url: 'https://thesecondatomicage.com/fusion-power/',
    summary: 'Fusion\'s milestone ladder from first plasma to net electricity, machine by machine.',
  },
  {
    id: 'buildout', kind: 'explorer', title: 'The Buildout',
    url: 'https://thesecondatomicage.com/buildout/',
    summary: 'A US map of every sited design and firm order, sized by capacity and colored by progress.',
    categories: ['new-build', 'doe-site'],
  },
  {
    id: 'order-book', kind: 'explorer', title: 'The Order Book',
    url: 'https://thesecondatomicage.com/order-book/',
    summary: 'Who has agreed to buy how many megawatts, and how much of the headline order book is firm.',
    categories: ['new-build'],
  },
  {
    id: 'fuel-cycle', kind: 'explorer', title: 'The Fuel Cycle',
    url: 'https://thesecondatomicage.com/fuel-cycle/',
    summary: 'The nine stages from mine to repository and who is rebuilding each one, HALEU included.',
    categories: ['fuel-cycle'],
  },
  {
    id: 'timeline', kind: 'explorer', title: 'Paper to Power',
    url: 'https://thesecondatomicage.com/timeline/',
    summary: 'Every design on one clock, from design approval through licensing and construction to operation.',
    categories: ['new-build'],
  },
  {
    id: 'design-space', kind: 'explorer', title: 'The Design Space',
    url: 'https://thesecondatomicage.com/design-space/',
    summary: 'Regroup the advanced-reactor field by size, fuel, moderator, coolant and target industry.',
  },
  {
    id: 'factory-floor', kind: 'explorer', title: 'The Factory Floor',
    url: 'https://thesecondatomicage.com/factory-floor/',
    summary: 'Who has a reactor production line, what it is sized for, and how that compares with announced demand.',
  },
  {
    id: 'companies', kind: 'reference', title: 'Company Profiles',
    url: 'https://thesecondatomicage.com/companies/',
    summary: 'Every developer: the machines it is building, its designs, order book and latest news.',
    categories: ['new-build'],
  },
  {
    id: 'profiles', kind: 'reference', title: 'Reactor Profiles',
    url: 'https://thesecondatomicage.com/profiles/',
    summary: 'One spec table per reactor: power, enrichment, fuel form, coolant, moderator, spectrum and power density.',
    categories: ['new-build'],
  },
  {
    id: 'anatomy', kind: 'reference', title: 'Reactor Anatomy',
    url: 'https://thesecondatomicage.com/anatomy/',
    summary: 'The design dimensions and archetypes of advanced reactors, and which current designs fit each.',
  },
  {
    id: 'lcoe', kind: 'calculator', title: 'LCOE Calculator',
    url: 'https://thesecondatomicage.com/lcoe/',
    summary: 'Levelized cost of electricity across reactor designs, with capital, fuel and operating inputs you can tune.',
  },
];

/** Tools worth linking from a registry facility of the given category, most relevant first. */
export function secondAtomicAgeToolsFor(category: string): SecondAtomicAgeTool[] {
  return SECOND_ATOMIC_AGE_TOOLS.filter((t) => t.categories?.includes(category as 'new-build'));
}

/** The attribution line their citation guidance asks for: author, tool, URL and access date. */
export function secondAtomicAgeCitation(tool: SecondAtomicAgeTool, accessed: string = SECOND_ATOMIC_AGE.reviewed): string {
  return `${SECOND_ATOMIC_AGE.name}, "${tool.title}", ${tool.url}, accessed ${accessed}`;
}
