require "bundler/gem_tasks"
require "rake/testtask"

Rake::TestTask.new(:test) do |t|
  t.libs << "test"
  t.libs << "lib"
  t.test_files = FileList["test/**/test_*.rb"]
end

namespace :rbs do
  Rake::TestTask.new(test: :compile) do |t|
    t.libs << "test_sig"
    t.ruby_opts << "-rtest_helper"
    t.test_files = FileList["test_sig/test_*.rb"]
    t.warning = true
  end

  desc 'Update RBS comments'
  task :annotate do
    require "tmpdir"

    Dir.mktmpdir do |tmpdir|
      sh("rdoc --ri --output #{tmpdir}/doc --root=. lib")
      sh("rbs annotate --no-system --no-gems --no-site --no-home -d #{tmpdir}/doc sig")
    end
  end
end

if RUBY_ENGINE == "jruby"
  require "rake/javaextensiontask"
  Rake::JavaExtensionTask.new("nkf") do |ext|
    ext.source_version = "1.8"
    ext.target_version = "1.8"
    ext.ext_dir = "ext/java"
  end

  task :build => :compile
else
  require 'rake/extensiontask'
  Rake::ExtensionTask.new("nkf")
end

task :default => :test
