# -*- encoding: utf-8 -*-
# stub: ethon 0.19.2 ruby lib

Gem::Specification.new do |s|
  s.name = "ethon".freeze
  s.version = "0.19.2".freeze

  s.required_rubygems_version = Gem::Requirement.new(">= 0".freeze) if s.respond_to? :required_rubygems_version=
  s.metadata = { "bug_tracker_uri" => "https://github.com/typhoeus/ethon/issues", "changelog_uri" => "https://github.com/typhoeus/ethon/blob/v0.19.2/CHANGELOG.md", "documentation_uri" => "https://www.rubydoc.info/gems/ethon/0.19.2", "rubygems_mfa_required" => "true", "source_code_uri" => "https://github.com/typhoeus/ethon/tree/v0.19.2" } if s.respond_to? :metadata=
  s.require_paths = ["lib".freeze]
  s.authors = ["Hans Hasselberg".freeze]
  s.date = "2026-11-12"
  s.description = "Very lightweight libcurl wrapper.".freeze
  s.email = ["me@hans.io".freeze]
  s.homepage = "https://github.com/typhoeus/ethon".freeze
  s.licenses = ["MIT".freeze]
  s.required_ruby_version = Gem::Requirement.new(">= 2.6".freeze)
  s.rubygems_version = "3.4.19".freeze
  s.summary = "Libcurl wrapper.".freeze

  s.installed_by_version = "4.0.3".freeze

  s.specification_version = 4

  s.add_runtime_dependency(%q<ffi>.freeze, [">= 1.15.0".freeze])
  s.add_runtime_dependency(%q<logger>.freeze, [">= 0".freeze])
end
