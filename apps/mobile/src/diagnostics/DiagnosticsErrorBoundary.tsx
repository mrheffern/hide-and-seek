import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { reloadAppAsync } from "expo";
import { recordDiagnosticError } from ".";

interface State { crashed: boolean; restartFailed?: boolean; }

export class DiagnosticsErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    recordDiagnosticError("crash", "react_render_error", error, { componentStack: info.componentStack }, true);
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Out of Sight hit an error</Text>
        <Text style={styles.copy}>The crash was saved in the beta diagnostics log.</Text>
        {this.state.restartFailed ? <Text style={styles.copy}>Close and reopen the app to continue.</Text> : null}
        <Pressable style={styles.button} onPress={() => {
          void reloadAppAsync().catch((error: unknown) => {
            recordDiagnosticError("crash", "app_restart_failed", error);
            this.setState({ restartFailed: true });
          });
        }}>
          <Text style={styles.buttonText}>Restart app</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 28, backgroundColor: "#f4f7f1" },
  title: { color: "#132019", fontSize: 28, fontWeight: "900", marginBottom: 12 },
  copy: { color: "#66736b", fontSize: 16, lineHeight: 23, marginBottom: 24 },
  button: { minHeight: 50, borderRadius: 13, backgroundColor: "#176b45", alignItems: "center", justifyContent: "center" },
  buttonText: { color: "white", fontWeight: "800", fontSize: 16 },
});
