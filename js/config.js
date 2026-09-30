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

// The app this panel manages: SmartRoute (data under labUsers/{uid}). SmartRun (users/{uid}) is archived.
export const APP = { name: 'SmartRoute', root: 'labUsers', url: 'https://gbitman84.github.io/smartroute/' };

export const magicLink = (token) => `${APP.url}?invite=${token}`;
export const registrationLink = (ref) => `${APP.url}Registration?ref=${encodeURIComponent(ref)}`;
