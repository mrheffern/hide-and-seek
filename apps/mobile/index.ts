import { registerRootComponent } from 'expo';
import React from 'react';

import './src/location/backgroundLocation';

import App from './App';
import { DiagnosticsErrorBoundary } from './src/diagnostics/DiagnosticsErrorBoundary';
import { initializeDiagnostics, installGlobalErrorHandler } from './src/diagnostics';
import { wrapWithSentry } from './src/diagnostics/sentry';
import { initializeGameplayAudio } from './src/audio/gameplayAudio';

installGlobalErrorHandler();
void initializeDiagnostics();
void initializeGameplayAudio();

function Root() {
  return React.createElement(DiagnosticsErrorBoundary, null, React.createElement(App));
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(wrapWithSentry(Root));
