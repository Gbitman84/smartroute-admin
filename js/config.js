// Same Firebase project as SmartRoute (smartrun-gbit). These values are public by design;
// every permission is enforced by firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyCDTUNXA7o1jZo2quZ1bBhNj7SK5yjf8fE',
  authDomain: 'smartrun-gbit.firebaseapp.com',
  projectId: 'smartrun-gbit',
  storageBucket: 'smartrun-gbit.firebasestorage.app',
  messagingSenderId: '265332673817',
  appId: '1:265332673817:web:128578d24c66ba4f87c988',
};

// SUPERADMIN – the only account that can make admins. Must match isSuper() in firestore.rules.
export const SUPERADMIN = 'gbitman.bd@gmail.com';

// The app this panel manages: SmartRoute (data under labUsers/{uid}).
export const APP = { name: 'SmartRoute', root: 'labUsers', url: 'https://gbitman84.github.io/smartroute/' };

// Daily limits per role for the SmartRoute Cloud Functions (config/limits). Must match DEFAULT_LIMITS in
// SmartRoute/functions/access.js – used until the superadmin saves their own values. Empty = no role cap.
export const LIMIT_KINDS = [['routeOpt', 'בניית מסלול חכם (Google) ביום', 'routeopt', 'requests'], ['scanReads', 'קריאת צילומים ביום', 'extract', 'reads']];
export const DEFAULT_LIMITS = {
  roles: { super: { routeOpt: 40, scanReads: 120 }, admin: { routeOpt: 40, scanReads: 120 }, user: { routeOpt: 40, scanReads: 120 } },
  global: { routeOpt: 40, scanReads: 120 },
};
export const ROLE_LABELS = { super: '⭐ מנהל ראשי', admin: '👑 מנהל', user: 'משתמש' };

export const magicLink = (token) => `${APP.url}?invite=${token}`;
export const registrationLink = (ref) => `${APP.url}Registration?ref=${encodeURIComponent(ref)}`;
