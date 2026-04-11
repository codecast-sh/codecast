import { useState } from 'react';
import {
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  View,
} from 'react-native';
import { Text } from '@/components/Themed';
import { useAuth } from '@/lib/auth';
import { Link } from 'expo-router';
import { Theme, Spacing, FontSize, BorderRadius } from '@/constants/Theme';
import { Feather, Ionicons } from '@expo/vector-icons';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const { signInWithGitHub, signInWithApple, signInWithEmail, isAppleAuthAvailable } = useAuth();

  const handleAppleSignIn = async () => {
    setLoading(true);
    try {
      await signInWithApple();
    } catch (error: any) {
      if (error?.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Error', 'Apple sign in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGitHubSignIn = async () => {
    setLoading(true);
    try {
      await signInWithGitHub();
    } catch (error) {
      Alert.alert('Error', 'GitHub sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSignIn = async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }

    setLoading(true);
    try {
      await signInWithEmail(email, password);
    } catch (error: any) {
      const message = error?.message || 'Sign in failed';
      if (message.includes('Invalid') || message.includes('credentials')) {
        Alert.alert('Error', 'Invalid email or password');
      } else if (message.includes('not found')) {
        Alert.alert('Error', 'No account found with this email');
      } else {
        Alert.alert('Error', 'Sign in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <Image
              source={require('@/assets/images/logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />
          </View>
          <Text style={styles.title}>codecast</Text>
          <Text style={styles.subtitle}>Sign in to access your conversations</Text>
        </View>

        <View style={styles.buttonsContainer}>
          {isAppleAuthAvailable && (
            <TouchableOpacity
              style={[styles.appleButton, loading && styles.buttonDisabled]}
              onPress={handleAppleSignIn}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading && !showEmailForm ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <View style={styles.buttonContent}>
                  <Ionicons name="logo-apple" size={20} color="#fff" style={styles.buttonIcon} />
                  <Text style={styles.appleButtonText}>Continue with Apple</Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.githubButton, loading && styles.buttonDisabled]}
            onPress={handleGitHubSignIn}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading && !showEmailForm ? (
              <ActivityIndicator color={Theme.text} />
            ) : (
              <View style={styles.buttonContent}>
                <Feather name="github" size={18} color={Theme.text} style={styles.buttonIcon} />
                <Text style={styles.githubButtonText}>Continue with GitHub</Text>
              </View>
            )}
          </TouchableOpacity>

          {!showEmailForm ? (
            <TouchableOpacity
              style={styles.emailToggle}
              onPress={() => setShowEmailForm(true)}
              activeOpacity={0.7}
            >
              <View style={styles.buttonContent}>
                <Feather name="mail" size={16} color={Theme.accentAmber} style={styles.buttonIcon} />
                <Text style={styles.emailToggleText}>Sign in with email</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <>
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.dividerLine} />
              </View>

              <View style={styles.inputContainer}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  placeholder="you@example.com"
                  placeholderTextColor={Theme.inputPlaceholder}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  editable={!loading}
                />
              </View>

              <View style={styles.inputContainer}>
                <Text style={styles.label}>Password</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor={Theme.inputPlaceholder}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="password"
                  editable={!loading}
                />
              </View>

              <TouchableOpacity
                style={[styles.signInButton, loading && styles.buttonDisabled]}
                onPress={handleEmailSignIn}
                disabled={loading}
                activeOpacity={0.8}
              >
                {loading && showEmailForm ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.signInButtonText}>Sign In</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.backButton}
                onPress={() => setShowEmailForm(false)}
              >
                <Text style={styles.backButtonText}>Back</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Don't have an account? </Text>
          <Link href="/auth/signup" asChild>
            <TouchableOpacity>
              <Text style={styles.footerLink}>Sign Up</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: Spacing.xxl,
  },
  header: {
    alignItems: 'center',
    marginBottom: Spacing.xxxl + 8,
  },
  logoContainer: {
    width: 88,
    height: 88,
    borderRadius: BorderRadius.xl + 6,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
    shadowColor: Theme.text,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  logo: {
    width: 56,
    height: 56,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    color: Theme.text,
    letterSpacing: -0.5,
    marginBottom: Spacing.xs,
  },
  subtitle: {
    fontSize: FontSize.md,
    color: Theme.textMuted,
    letterSpacing: 0.1,
  },
  buttonsContainer: {
    gap: Spacing.md,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonIcon: {
    marginRight: Spacing.sm + 2,
  },
  appleButton: {
    backgroundColor: Theme.text,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
  },
  appleButtonText: {
    color: '#fff',
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  githubButton: {
    backgroundColor: Theme.bgAlt,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  githubButtonText: {
    color: Theme.text,
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  emailToggle: {
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  emailToggleText: {
    color: Theme.accentAmber,
    fontSize: FontSize.md + 1,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: Spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Theme.borderLight,
  },
  dividerText: {
    marginHorizontal: Spacing.md,
    color: Theme.textMuted0,
    fontSize: FontSize.sm,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  inputContainer: {
    marginBottom: Spacing.sm,
  },
  label: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Theme.textMuted,
    marginBottom: Spacing.xs + 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: Theme.inputBg,
    borderWidth: 1,
    borderColor: Theme.inputBorder,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    fontSize: FontSize.lg,
    color: Theme.text,
  },
  signInButton: {
    backgroundColor: Theme.accentAmber,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  signInButtonText: {
    color: '#fff',
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  backButton: {
    paddingVertical: Spacing.sm,
    alignItems: 'center',
  },
  backButtonText: {
    color: Theme.textMuted,
    fontSize: FontSize.md,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.xxxl,
  },
  footerText: {
    color: Theme.textMuted,
    fontSize: FontSize.md,
  },
  footerLink: {
    color: Theme.accentAmber,
    fontSize: FontSize.md,
    fontWeight: '700',
  },
});
