export type AuthMode = "login" | "register";

type AuthErrorLike = {
  code?: string;
  message?: string;
  status?: number;
};

export function registrationValidationError(
  password: string,
  confirmation: string,
) {
  if (password !== confirmation) return "两次输入的密码不一致。";
  return null;
}

export function registrationErrorMessage(error: AuthErrorLike) {
  const message = error.message?.toLowerCase() ?? "";
  const code = error.code?.toLowerCase() ?? "";

  if (
    code === "user_already_exists" ||
    message.includes("already registered") ||
    message.includes("already exists")
  )
    return "该邮箱已注册，请直接登录。";

  if (
    code === "weak_password" ||
    message.includes("password") ||
    message.includes("characters")
  )
    return "密码不符合注册要求，请根据提示调整后重试。";

  if (code === "email_address_invalid" || message.includes("invalid email"))
    return "邮箱格式不正确，请检查后重试。";

  if (error.status === 429 || message.includes("rate limit"))
    return "请求过于频繁，请稍后再试。";

  return "注册失败，请稍后重试。";
}
