export interface ProfileConfig {
  id: string;
  name: string;
  title: string;
  route: string;
  artboardWidth: number;
  gangsheetHeights: number[];
  downloadFormat: 'png' | 'pdf';
  enableFluorescent: boolean;
  description: string;
  comingSoon?: boolean;
}

export const HOT_PEEL_PROFILE: ProfileConfig = {
  id: 'hot-peel',
  name: 'Hot Peel DTF',
  title: 'HOT PEEL DTF',
  route: '/hot-peel',
  artboardWidth: 24.5,
  gangsheetHeights: [12, 18, 24, 35, 40, 45, 48, 50, 55, 60, 65, 70, 80, 85, 95, 110, 120, 130, 140, 150],
  downloadFormat: 'png',
  enableFluorescent: false,
  description: 'Hot peel High Quality Direct to film gangsheets that are perfect to heatpress on any color garment. Heatpress instructions are 275F for 15 seconds, hot/cold peel and repress for another 5-10 seconds.',
};

export const FLUORESCENT_PROFILE: ProfileConfig = {
  id: 'fluorescent',
  name: 'Fluorescent Gangsheet',
  title: 'FLUORESCENT GANGSHEET',
  route: '/fluorescent',
  artboardWidth: 24,
  gangsheetHeights: [12, 14, 16, 18],
  downloadFormat: 'pdf',
  enableFluorescent: true,
  description: 'Uv Light Reactive transfers, You select what color from your design you want the flourecent ink printed and watch the magic happen',
  comingSoon: true,
};

export const UV_DTF_PROFILE: ProfileConfig = {
  id: 'uv-dtf',
  name: 'UV-DTF',
  title: 'UV-DTF GANGSHEET',
  route: '/uv-dtf',
  artboardWidth: 22,
  gangsheetHeights: [12, 18, 24, 35, 40, 45, 48, 50, 55, 60, 65, 70, 80, 85, 95, 100],
  downloadFormat: 'png',
  enableFluorescent: false,
  description: 'Perfect UV stickers that go on acrylic, plastic, glass and many hard surfaces. Not dishwasher safe.',
};

export const SPECIALTY_DTF_PROFILE: ProfileConfig = {
  id: 'specialty-dtf',
  name: 'Specialty DTF',
  title: 'SPECIALTY DTF GANGSHEET',
  route: '/specialty-dtf',
  artboardWidth: 22,
  gangsheetHeights: [12, 18, 24, 35, 40, 45, 48, 50, 55, 60],
  downloadFormat: 'png',
  enableFluorescent: false,
  description: 'Use a parchment paper or teflon sheet over the transfer, press at 325F for 15 seconds and peel completely COLD! will not work on canvas material but it works on cotton/polyester tshirts.',
};

export const ALL_PROFILES = [HOT_PEEL_PROFILE, UV_DTF_PROFILE, SPECIALTY_DTF_PROFILE, FLUORESCENT_PROFILE];

export function getProfileById(id: string): ProfileConfig {
  return ALL_PROFILES.find(p => p.id === id) ?? HOT_PEEL_PROFILE;
}
