import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * 验证设备ID格式
 */
export function IsDeviceId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDeviceId',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          // 设备ID格式：字母数字组合，长度8-32
          return (
            typeof value === 'string' && /^[a-zA-Z0-9_-]{8,32}$/.test(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid device ID (8-32 alphanumeric characters)`;
        },
      },
    });
  };
}

/**
 * 验证手机号格式
 */
export function IsPhoneNumber(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPhoneNumber',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          // 中国手机号格式
          return typeof value === 'string' && /^1[3-9]\d{9}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid Chinese phone number`;
        },
      },
    });
  };
}

/**
 * 验证绑定码格式
 */
export function IsBindingCode(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBindingCode',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          // 绑定码格式：6位数字
          return typeof value === 'string' && /^\d{6}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a 6-digit binding code`;
        },
      },
    });
  };
}

/**
 * 验证时间范围
 */
export function IsTimeRange(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isTimeRange',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          if (typeof value !== 'string') {
            return false;
          }
          // 验证ISO 8601格式的时间戳
          const date = new Date(value);
          return !isNaN(date.getTime());
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid ISO 8601 timestamp`;
        },
      },
    });
  };
}

/**
 * 验证心率范围
 */
export function IsHeartRate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isHeartRate',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          return typeof value === 'number' && value >= 30 && value <= 200;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be between 30 and 200 bpm`;
        },
      },
    });
  };
}

/**
 * 验证呼吸率范围
 */
export function IsBreathingRate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBreathingRate',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          return typeof value === 'number' && value >= 6 && value <= 40;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be between 6 and 40 times/min`;
        },
      },
    });
  };
}

/**
 * 验证睡眠状态
 */
export function IsSleepState(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSleepState',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const validStates = [
            'awake',
            'light_sleep',
            'deep_sleep',
            'rem_sleep',
            'unknown',
          ];
          return typeof value === 'string' && validStates.includes(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be one of: awake, light_sleep, deep_sleep, rem_sleep, unknown`;
        },
      },
    });
  };
}

/**
 * 验证报警级别
 */
export function IsAlarmLevel(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAlarmLevel',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const validLevels = ['info', 'warning', 'error', 'critical'];
          return typeof value === 'string' && validLevels.includes(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be one of: info, warning, error, critical`;
        },
      },
    });
  };
}

/**
 * 验证设备类型
 */
export function IsDeviceType(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDeviceType',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const validTypes = ['sleep_lamp', 'sleep_monitor', 'smart_bed'];
          return typeof value === 'string' && validTypes.includes(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be one of: sleep_lamp, sleep_monitor, smart_bed`;
        },
      },
    });
  };
}

/**
 * 验证MAC地址格式
 */
export function IsMacAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isMacAddress',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          // MAC地址格式：XX:XX:XX:XX:XX:XX
          return (
            typeof value === 'string' &&
            /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid MAC address (XX:XX:XX:XX:XX:XX)`;
        },
      },
    });
  };
}

/**
 * 验证优先级范围
 */
export function IsPriority(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPriority',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          return typeof value === 'number' && value >= 1 && value <= 10;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be between 1 and 10`;
        },
      },
    });
  };
}
