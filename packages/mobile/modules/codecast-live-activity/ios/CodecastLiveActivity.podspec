Pod::Spec.new do |s|
  s.name           = 'CodecastLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'ActivityKit bridge for the Codecast Lock Screen Live Activity'
  s.description    = 'Hands ActivityKit push tokens to JS and starts the activity locally on phones without push-to-start.'
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
