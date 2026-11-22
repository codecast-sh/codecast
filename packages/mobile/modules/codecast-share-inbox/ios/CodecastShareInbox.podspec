Pod::Spec.new do |s|
  s.name           = 'CodecastShareInbox'
  s.version        = '1.0.0'
  s.summary        = 'Hands the app the images shared to it from the iOS share sheet'
  s.description    = 'Reads the images the share extension left in the app group and moves them into the app for a new session to attach.'
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
