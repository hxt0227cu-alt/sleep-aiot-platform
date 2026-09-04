export const validators = {
  phone: (value: string): boolean => /^1[3-9]\d{9}$/.test(value),
  password: (value: string): boolean => value.length >= 6 && value.length <= 20,
  email: (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  nickname: (value: string): boolean => value.length >= 2 && value.length <= 20,
  deviceId: (value: string): boolean => /^[a-zA-Z0-9_-]+$/.test(value) && value.length >= 4,
  bindingCode: (value: string): boolean => /^\d{6}$/.test(value),
}

export const errorMessages = {
  phone: '请输入正确的手机号码',
  password: '密码长度应为 6-20 位',
  email: '请输入正确的邮箱地址',
  nickname: '昵称长度应为 2-20 位',
  deviceId: '设备 ID 格式不正确',
  bindingCode: '请输入 6 位数字绑定码',
  required: '此项为必填项',
}

export const validateForm = <T extends Record<string, unknown>>(
  data: T,
  rules: Partial<Record<keyof T, (value: unknown) => boolean>>,
): { valid: boolean; errors: Partial<Record<keyof T, string>> } => {
  const errors: Partial<Record<keyof T, string>> = {}

  for (const key in rules) {
    const rule = rules[key]
    if (rule && !rule(data[key])) {
      errors[key] = errorMessages[key as keyof typeof errorMessages] || errorMessages.required
    }
  }

  return { valid: Object.keys(errors).length === 0, errors }
}
