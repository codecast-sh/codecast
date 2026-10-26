Pod::Spec.new do |s|
  s.name           = 'CodecastPushPrefetch'
  s.version        = '1.0.0'
  s.summary        = 'Shares the sign-in and reads the rows the notification service extension prefetched'
  s.description    = 'Writes the access token to a shared keychain group and the conversation watermarks to the app group, and hands JS the rows the extension fetched.'
  s.author         = 'Codecast'
  s.homepage       = 'https://codecast.sh'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
