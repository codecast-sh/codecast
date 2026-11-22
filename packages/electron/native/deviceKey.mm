// N-API face of deviceKey.swift: available() answers at once; create and sign
// return promises, run on a worker thread because each waits on the Touch ID
// prompt, and resolve with the Swift side's JSON string.
#include <node_api.h>
#include <stdlib.h>
#include <string>

extern "C" bool cc_dk_available(void);
extern "C" char* cc_dk_create(const char* message, const char* reason);
extern "C" char* cc_dk_sign(const char* blob, const char* message, const char* reason);

struct Job {
  napi_async_work work;
  napi_deferred deferred;
  bool create;
  std::string blob, message, reason;
  char* result = nullptr;
};

static std::string arg(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return "";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}

static void execute(napi_env, void* data) {
  Job* job = static_cast<Job*>(data);
  job->result = job->create ? cc_dk_create(job->message.c_str(), job->reason.c_str())
                            : cc_dk_sign(job->blob.c_str(), job->message.c_str(), job->reason.c_str());
}

static void complete(napi_env env, napi_status, void* data) {
  Job* job = static_cast<Job*>(data);
  napi_value out;
  napi_create_string_utf8(env, job->result ? job->result : "{\"error\":\"no answer\"}", NAPI_AUTO_LENGTH, &out);
  napi_resolve_deferred(env, job->deferred, out);
  napi_delete_async_work(env, job->work);
  free(job->result);
  delete job;
}

static napi_value start(napi_env env, napi_callback_info info, bool create) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  Job* job = new Job();
  job->create = create;
  if (create) {
    job->message = arg(env, argv[0]);
    job->reason = arg(env, argv[1]);
  } else {
    job->blob = arg(env, argv[0]);
    job->message = arg(env, argv[1]);
    job->reason = arg(env, argv[2]);
  }
  napi_value promise, name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "deviceKey", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, execute, complete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

static napi_value Create(napi_env env, napi_callback_info info) { return start(env, info, true); }
static napi_value Sign(napi_env env, napi_callback_info info) { return start(env, info, false); }
static napi_value Available(napi_env env, napi_callback_info) {
  napi_value out;
  napi_get_boolean(env, cc_dk_available(), &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"available", nullptr, Available, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sign", nullptr, Sign, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, props);
  return exports;
}

NAPI_MODULE(deviceKey, Init)
