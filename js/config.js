// Same Firebase project as SmartRoute (smartrun-gbit). These values are public by design;
// access is enforced by firestore.rules (isAdmin() – keep ADMIN_EMAILS in sync with it).
export const firebaseConfig = {
  apiKey: 'AIzaSyCDTUNXA7o1jZo2quZ1bBhNj7SK5yjf8fE',
  authDomain: 'smartrun-gbit.firebaseapp.com',
  projectId: 'smartrun-gbit',
  storageBucket: 'smartrun-gbit.firebasestorage.app',
  messagingSenderId: '265332673817',
  appId: '1:265332673817:web:128578d24c66ba4f87c988',
};

export const ADMIN_EMAILS = ['gbitman.bd@gmail.com'];

// The app this panel manages: SmartRoute (data under labUsers/{uid}). SmartRun (users/{uid}) is archived.
export const APP = { name: 'SmartRoute', root: 'labUsers' };
