import assert from "node:assert/strict";
import test from "node:test";
import {
  registrationErrorMessage,
  registrationValidationError,
} from "../src/lib/auth.ts";

test("registration validates matching passwords without adding password rules", () => {
  assert.equal(registrationValidationError("same", "same"), null);
  assert.equal(
    registrationValidationError("first", "second"),
    "两次输入的密码不一致。",
  );
});

test("registration errors are mapped to friendly messages", () => {
  assert.equal(
    registrationErrorMessage({ message: "User already registered" }),
    "该邮箱已注册，请直接登录。",
  );
  assert.equal(
    registrationErrorMessage({ code: "weak_password" }),
    "密码不符合注册要求，请根据提示调整后重试。",
  );
  assert.equal(
    registrationErrorMessage({ message: "Invalid email address" }),
    "邮箱格式不正确，请检查后重试。",
  );
  assert.equal(
    registrationErrorMessage({ status: 429 }),
    "请求过于频繁，请稍后再试。",
  );
  assert.equal(
    registrationErrorMessage({ message: "internal detail that stays hidden" }),
    "注册失败，请稍后重试。",
  );
});
