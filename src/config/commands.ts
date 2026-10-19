import type { MapLayers } from '@/types';
import { CURATED_COUNTRIES } from '@/config/countries';
// boundary-ignore: commands are built lazily at runtime via getAllCommands()
import { getCurrentLanguage, getCurrentLanguageTag, t } from '@/services/i18n';
import { toFlagEmoji } from '@/utils/country-flag';

export interface Command {
  id: string;
  keywords: string[];
  label: string;
  icon: string;
  category: 'navigate' | 'layers' | 'panels' | 'view' | 'actions' | 'country';
}

export const LAYER_PRESETS: Record<string, (keyof MapLayers)[]> = {
  infra: ['cables', 'pipelines', 'datacenters'],
};

// Maps command suffix → actual MapLayers key when they differ
export const LAYER_KEY_MAP: Record<string, keyof MapLayers> = {
  radiation: 'radiationWatch',
  natural: 'natural',
};

export const COMMANDS: Command[] = [
  // Navigation (region switching)
  { id: 'nav:global', keywords: ['global', 'world', 'reset', 'home'], label: 'Map: Global view', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:mena', keywords: ['mena', 'middle east', 'mideast'], label: 'Map: Middle East & North Africa', icon: '\u{1F54C}', category: 'navigate' },
  { id: 'nav:eu', keywords: ['europe', 'eu'], label: 'Map: Europe', icon: '\u{1F3F0}', category: 'navigate' },
  { id: 'nav:asia', keywords: ['asia', 'pacific'], label: 'Map: Asia-Pacific', icon: '\u{1F3EF}', category: 'navigate' },
  { id: 'nav:america', keywords: ['america', 'americas', 'us', 'usa'], label: 'Map: Americas', icon: '\u{1F5FD}', category: 'navigate' },
  { id: 'nav:africa', keywords: ['africa'], label: 'Map: Africa', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:latam', keywords: ['latam', 'latin america', 'south america'], label: 'Map: Latin America', icon: '\u{1F30E}', category: 'navigate' },
  { id: 'nav:oceania', keywords: ['oceania', 'australia', 'pacific islands'], label: 'Map: Oceania', icon: '\u{1F30F}', category: 'navigate' },

  // Layer presets (toggle groups)
  { id: 'layers:infra', keywords: ['infrastructure', 'infra layers', 'show infrastructure'], label: 'Show infrastructure layers', icon: '\u{1F3D7}\uFE0F', category: 'layers' },
  { id: 'layers:all', keywords: ['all layers', 'show all', 'enable all'], label: 'Enable all layers', icon: '\u{1F441}\uFE0F', category: 'layers' },
  { id: 'layers:none', keywords: ['hide all', 'clear layers', 'no layers', 'disable all'], label: 'Hide all layers', icon: '\u{1F6AB}', category: 'layers' },

  // Individual layer toggles
  { id: 'layer:cables', keywords: ['cables', 'undersea', 'submarine cables'], label: 'Toggle undersea cables', icon: '\u{1F310}', category: 'layers' },
  { id: 'layer:pipelines', keywords: ['pipelines', 'oil', 'gas pipelines'], label: 'Toggle pipelines', icon: '\u{1F6E2}\uFE0F', category: 'layers' },
  { id: 'layer:nuclear', keywords: ['nuclear', 'reactors'], label: 'Toggle nuclear facilities', icon: '\u2622\uFE0F', category: 'layers' },
  { id: 'layer:fires', keywords: ['fires', 'wildfires'], label: 'Toggle satellite fires', icon: '\u{1F525}', category: 'layers' },
  { id: 'layer:weather', keywords: ['weather'], label: 'Toggle weather overlay', icon: '\u{1F324}\uFE0F', category: 'layers' },
  { id: 'layer:climate', keywords: ['climate', 'anomalies'], label: 'Toggle climate anomalies', icon: '\u{1F321}\uFE0F', category: 'layers' },
  { id: 'layer:outages', keywords: ['outages', 'internet outages', 'internet disruptions', 'disruptions'], label: 'Toggle internet disruptions', icon: '\u{1F4E1}', category: 'layers' },
  { id: 'layer:irradiators', keywords: ['irradiators', 'gamma', 'radiation'], label: 'Toggle gamma irradiators', icon: '\u2623\uFE0F', category: 'layers' },
  { id: 'layer:radiation', keywords: ['radiation', 'radnet', 'safecast', 'anomalies'], label: 'Toggle radiation anomalies', icon: '\u2622\uFE0F', category: 'layers' },
  { id: 'layer:usNuclearFacilities', keywords: ['us nuclear facilities', 'nuclear plants', 'nrc', 'reactors', 'doe sites', 'nucmonitor'], label: 'Toggle US nuclear facilities', icon: '\u2622\uFE0F', category: 'layers' },
  { id: 'layer:datacenters', keywords: ['datacenters', 'data centers', 'ai data'], label: 'Toggle AI data centers', icon: '\u{1F5A5}\uFE0F', category: 'layers' },
  { id: 'layer:natural', keywords: ['natural events', 'earthquakes', 'volcanoes', 'tsunamis'], label: 'Toggle natural events', icon: '\u{1F30B}', category: 'layers' },
  { id: 'layer:dayNight', keywords: ['day night', 'terminator', 'shadow', 'day/night'], label: 'Toggle day/night overlay', icon: '\u{1F31C}', category: 'layers' },

  // Panel navigation (matching actual DEFAULT_PANELS keys)
  { id: 'panel:live-news', keywords: ['news', 'live news', 'headlines'], label: 'Panel: Live News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:politics', keywords: ['world news', 'politics', 'geopolitics'], label: 'Panel: World News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:us', keywords: ['united states', 'us news', 'america news'], label: 'Panel: United States', icon: '\u{1F1FA}\u{1F1F8}', category: 'panels' },
  { id: 'panel:europe', keywords: ['europe news', 'eu news', 'europe', 'european'], label: 'Panel: Europe', icon: '\u{1F1EA}\u{1F1FA}', category: 'panels' },
  { id: 'panel:middleeast', keywords: ['middle east news', 'mideast news', 'middle east', 'gulf', 'levant'], label: 'Panel: Middle East', icon: '\u{1F54C}', category: 'panels' },
  { id: 'panel:africa', keywords: ['africa news', 'africa', 'african', 'sahel'], label: 'Panel: Africa', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:latam', keywords: ['latin america news', 'latam news', 'latin america', 'south america'], label: 'Panel: Latin America', icon: '\u{1F30E}', category: 'panels' },
  { id: 'panel:asia', keywords: ['asia news', 'asia-pacific news', 'asia', 'asia pacific', 'indo-pacific'], label: 'Panel: Asia-Pacific', icon: '\u{1F30F}', category: 'panels' },
  { id: 'panel:energy', keywords: ['energy', 'resources', 'oil news'], label: 'Panel: Energy & Resources', icon: '\u26A1', category: 'panels' },
  { id: 'panel:energy-complex', keywords: ['energy complex', 'oil markets', 'gas markets', 'energy prices'], label: 'Panel: Energy Complex', icon: '\u{1F6E2}\uFE0F', category: 'panels' },
  { id: 'panel:gov', keywords: ['government', 'gov', 'policy', 'legislation'], label: 'Panel: Government', icon: '\u{1F3DB}\uFE0F', category: 'panels' },
  { id: 'panel:thinktanks', keywords: ['think tanks', 'thinktanks', 'analysis'], label: 'Panel: Think Tanks', icon: '\u{1F9E0}', category: 'panels' },
  { id: 'panel:commodities', keywords: ['commodities', 'gold', 'silver'], label: 'Panel: Commodities', icon: '\u{1F4E6}', category: 'panels' },
  { id: 'panel:markets', keywords: ['markets', 'stocks', 'indices'], label: 'Panel: Markets', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:monitors', keywords: ['monitors', 'my monitors', 'watchlist'], label: 'Panel: My Monitors', icon: '\u{1F4CB}', category: 'panels' },
  { id: 'panel:map', keywords: ['map', 'globe', 'global map'], label: 'Panel: Global Map', icon: '\u{1F5FA}\uFE0F', category: 'panels' },
  { id: 'panel:live-webcams', keywords: ['webcams', 'live cameras', 'cctv'], label: 'Panel: Live Webcams', icon: '\u{1F4F7}', category: 'panels' },
  { id: 'panel:windy-webcams', keywords: ['windy', 'weather cam', 'weather webcam', 'weather cameras'], label: 'Panel: Live Weather Cams', icon: '\u{1F4F9}', category: 'panels' },
  { id: 'panel:satellite-fires', keywords: ['fires', 'satellite fires', 'wildfires', 'fire detections'], label: 'Panel: Fires', icon: '\u{1F525}', category: 'panels' },
  { id: 'panel:climate', keywords: ['climate', 'climate anomalies', 'temperature', 'weather patterns'], label: 'Panel: Climate Anomalies', icon: '\u{1F321}\uFE0F', category: 'panels' },
  { id: 'panel:population-exposure', keywords: ['population', 'exposure', 'population exposure', 'affected population'], label: 'Panel: Population Exposure', icon: '\u{1F465}', category: 'panels' },
  { id: 'panel:world-clock', keywords: ['clock', 'world clock', 'time zones', 'timezone'], label: 'Panel: World Clock', icon: '\u{1F570}\uFE0F', category: 'panels' },
  { id: 'panel:science', keywords: ['science', 'research', 'nature', 'climate science', 'space'], label: 'Panel: Science', icon: '\u{1F52C}', category: 'panels' },
  { id: 'panel:radiation-watch', keywords: ['radiation', 'nuclear', 'radnet', 'safecast', 'radiation watch'], label: 'Panel: Radiation Watch', icon: '\u2622\uFE0F', category: 'panels' },
  { id: 'panel:nuclear-reactor-status', keywords: ['reactor status', 'nrc status', 'power reactor status', 'reactor power', 'units offline', 'refueling outage'], label: 'Panel: NRC Reactor Power Status', icon: '\u2622\uFE0F', category: 'panels' },
  { id: 'panel:nuclear-hazards', keywords: ['nuclear hazards', 'all hazards', 'facility hazards', 'earthquake nuclear plant', 'hurricane nuclear plant', 'wildfire nuclear'], label: 'Panel: Facility All-Hazards Watch', icon: '\u26A0\uFE0F', category: 'panels' },
  { id: 'panel:nuclear-facilities', keywords: ['nuclear facilities', 'facility directory', 'nuclear plants list', 'nrc docket', 'doe sites', 'fuel cycle', 'research reactors'], label: 'Panel: US Nuclear Facility Directory', icon: '\u{1F4CB}', category: 'panels' },
  { id: 'panel:nuclear-regulatory', keywords: ['nrc news', 'doe news', 'iaea news', 'regulatory', 'official nuclear'], label: 'Panel: NRC, DOE & IAEA Official', icon: '\u{1F3DB}\uFE0F', category: 'panels' },
  { id: 'panel:nuclear-industry', keywords: ['nuclear industry', 'world nuclear news', 'smr news', 'uranium news', 'advanced reactors'], label: 'Panel: Nuclear Industry News', icon: '\u{1F3ED}', category: 'panels' },
  { id: 'panel:nuclear-policy', keywords: ['nuclear policy', 'spent fuel', 'nuclear waste', 'nonproliferation', 'nuclear security'], label: 'Panel: Nuclear Policy & Security', icon: '\u{1F4DC}', category: 'panels' },

  { id: 'panel:climate-news', keywords: ['climate news', 'climate headlines', 'environment news', 'climate intelligence', 'carbon brief', 'copernicus'], label: 'Panel: Climate News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:disease-outbreaks', keywords: ['disease outbreaks', 'outbreaks', 'who alerts', 'epidemic', 'health alerts', 'promed'], label: 'Panel: Disease Outbreaks', icon: '\u{1F9A0}', category: 'panels' },

  // View / settings
  { id: 'view:dark', keywords: ['dark', 'dark mode', 'night'], label: 'Switch to dark mode', icon: '\u{1F319}', category: 'view' },
  { id: 'view:light', keywords: ['light', 'light mode', 'day'], label: 'Switch to light mode', icon: '\u2600\uFE0F', category: 'view' },
  { id: 'view:fullscreen', keywords: ['fullscreen', 'full screen'], label: 'Toggle fullscreen', icon: '\u26F6', category: 'view' },
  { id: 'view:settings', keywords: ['settings', 'config', 'api keys'], label: 'Open settings', icon: '\u2699\uFE0F', category: 'view' },
  { id: 'view:refresh', keywords: ['refresh', 'reload', 'refresh all'], label: 'Refresh all data', icon: '\u{1F504}', category: 'view' },

  // Time range
  { id: 'time:1h', keywords: ['1h', 'last hour', '1 hour'], label: 'Show events from last hour', icon: '\u{1F550}', category: 'actions' },
  { id: 'time:6h', keywords: ['6h', 'last 6 hours', '6 hours'], label: 'Show events from last 6 hours', icon: '\u{1F555}', category: 'actions' },
  { id: 'time:24h', keywords: ['24h', 'last 24 hours', 'today'], label: 'Show events from last 24 hours', icon: '\u{1F55B}', category: 'actions' },
  { id: 'time:48h', keywords: ['48h', '2 days', 'last 2 days'], label: 'Show events from last 48 hours', icon: '\u{1F4C5}', category: 'actions' },
  { id: 'time:7d', keywords: ['7d', 'week', 'last week', '7 days'], label: 'Show events from last 7 days', icon: '\u{1F5D3}\uFE0F', category: 'actions' },
];

// All ISO 3166-1 alpha-2 codes — Intl.DisplayNames resolves human-readable names at runtime
const ISO_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF',
  'BG', 'BH', 'BI', 'BJ', 'BN', 'BO', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG',
  'CH', 'CI', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO',
  'DZ', 'EC', 'EE', 'EG', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FM', 'FR', 'GA', 'GB', 'GD', 'GE', 'GH',
  'GM', 'GN', 'GQ', 'GR', 'GT', 'GW', 'GY', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IN', 'IQ',
  'IR', 'IS', 'IT', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MG',
  'MH', 'MK', 'ML', 'MM', 'MN', 'MR', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NE', 'NG',
  'NI', 'NL', 'NO', 'NP', 'NR', 'NZ', 'OM', 'PA', 'PE', 'PG', 'PH', 'PK', 'PL', 'PS', 'PT', 'PW',
  'PY', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SY', 'SZ', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VN', 'VU', 'WS',
  'YE', 'ZA', 'ZM', 'ZW',
];

let _cachedLang = '';
let _cachedCountryCommands: Command[] = [];
let _cachedAllCommands: Command[] = [];

const KEYWORD_I18N_MAP: Record<string, string> = {
  infrastructure: 'commands.keywords.infrastructure',
  news: 'commands.keywords.news',
  dark: 'commands.keywords.dark',
  light: 'commands.keywords.light',
  settings: 'commands.keywords.settings',
  fullscreen: 'commands.keywords.fullscreen',
  refresh: 'commands.keywords.refresh',
};

function injectLocalizedKeywords(commands: Command[]): Command[] {
  const lang = getCurrentLanguage();
  if (lang === 'en') return commands;

  return commands.map(cmd => {
    const extra: string[] = [];
    for (const kw of cmd.keywords) {
      const i18nKey = KEYWORD_I18N_MAP[kw];
      if (i18nKey) {
        const localized = t(i18nKey).toLowerCase();
        if (localized !== kw && !cmd.keywords.includes(localized)) {
          extra.push(localized);
        }
      }
    }
    if (extra.length === 0) return cmd;
    return { ...cmd, keywords: [...cmd.keywords, ...extra] };
  });
}

function buildCountryCommands(): Command[] {
  // Script-sensitive, so the full tag: Intl.DisplayNames renders `zh` as
  // Simplified — 美国, and 韩国 where Traditional readers say 南韓, a different
  // word rather than a different character. The memo key reads the same
  // accessor on purpose; keying it on the stripped code would let whichever
  // catalogue built first answer for both.
  const lang = getCurrentLanguageTag();
  if (lang === _cachedLang && _cachedCountryCommands.length > 0) {
    return _cachedCountryCommands;
  }

  const displayNames = new Intl.DisplayNames([lang], { type: 'region' });

  const result = ISO_CODES.flatMap(code => {
    const curated = CURATED_COUNTRIES[code];
    const name = displayNames.of(code) || curated?.name || code;
    const keywords = curated
      ? [name.toLowerCase(), curated.name.toLowerCase(), ...curated.searchAliases].filter(Boolean)
      : [name.toLowerCase()];
    return [
      {
        id: `country-map:${code}`,
        keywords: [...keywords, 'map'],
        label: name,
        icon: toFlagEmoji(code),
        category: 'navigate' as const,
      },
      {
        id: `country:${code}`,
        keywords: [...keywords, 'brief'],
        label: name,
        icon: toFlagEmoji(code),
        category: 'country' as const,
      },
    ];
  });

  _cachedLang = lang;
  _cachedCountryCommands = result;
  _cachedAllCommands = [...injectLocalizedKeywords(COMMANDS), ...result];
  return result;
}

export function getAllCommands(): Command[] {
  buildCountryCommands();
  return _cachedAllCommands.length > 0 ? _cachedAllCommands : COMMANDS;
}
