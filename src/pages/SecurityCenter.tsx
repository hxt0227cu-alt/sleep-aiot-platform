import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Modal,
  Form,
  Input,
  Select,
  DatePicker,
  Space,
  message,
  Popconfirm,
  Descriptions,
  Tabs,
  Badge,
  Tooltip,
  Typography,
  Row,
  Col,
  Statistic,
} from 'antd';
import {
  SafetyCertificateOutlined,
  KeyOutlined,
  ShieldOutlined,
  LockOutlined,
  EyeOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ReloadOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';

const { Title, Text, Paragraph } = Typography;
const { TabPane } = Tabs;

/**
 * 安全中心页面
 *
 * 功能：
 *   1. 安全概览（安全评分、风险项统计）
 *   2. 密钥管理（查看、轮换、吊销密钥）
 *   3. 证书管理（查看证书状态、到期提醒）
 *   4. 访问审计（查看安全事件日志）
 *   5. 合规检查（安全配置检查）
 */
const SecurityCenter: React.FC = () => {
  // 安全概览数据
  const [securityScore, setSecurityScore] = useState(85);
  const [riskStats, setRiskStats] = useState({
    critical: 0,
    high: 2,
    medium: 5,
    low: 12,
  });

  // 密钥列表
  const [keys, setKeys] = useState([
    {
      id: 'key_001',
      name: 'JWT 签名密钥',
      type: 'HMAC-SHA256',
      status: 'active',
      created_at: '2026-01-15',
      last_rotated: '2026-05-15',
      next_rotation: '2026-08-15',
      expires_in_days: 7,
    },
    {
      id: 'key_002',
      name: '数据库加密密钥',
      type: 'AES-256-GCM',
      status: 'active',
      created_at: '2026-01-10',
      last_rotated: '2026-04-10',
      next_rotation: '2026-10-10',
      expires_in_days: 70,
    },
    {
      id: 'key_003',
      name: 'API 签名密钥',
      type: 'HMAC-SHA256',
      status: 'active',
      created_at: '2026-02-01',
      last_rotated: '2026-06-01',
      next_rotation: '2026-12-01',
      expires_in_days: 122,
    },
    {
      id: 'key_004',
      name: '旧版会话密钥',
      type: 'AES-256',
      status: 'revoked',
      created_at: '2025-06-01',
      last_rotated: '2025-12-01',
      next_rotation: '-',
      expires_in_days: 0,
    },
  ]);

  // 证书列表
  const [certificates, setCertificates] = useState([
    {
      id: 'cert_001',
      name: 'api.sleep-monitor.com',
      type: 'TLS Server',
      issuer: "Let's Encrypt",
      status: 'valid',
      issued_at: '2026-06-01',
      expires_at: '2026-09-01',
      expires_in_days: 24,
    },
    {
      id: 'cert_002',
      name: 'Device CA Intermediate',
      type: 'Intermediate CA',
      issuer: 'Sleep Monitor Root CA',
      status: 'valid',
      issued_at: '2025-01-01',
      expires_at: '2027-01-01',
      expires_in_days: 497,
    },
    {
      id: 'cert_003',
      name: 'old.sleep-monitor.com',
      type: 'TLS Server',
      issuer: "Let's Encrypt",
      status: 'expiring_soon',
      issued_at: '2026-03-01',
      expires_at: '2026-08-25',
      expires_in_days: 3,
    },
  ]);

  // 审计日志
  const [auditLogs, setAuditLogs] = useState([
    {
      id: 'log_001',
      time: '2026-08-20 14:30:25',
      user: 'admin',
      action: 'key_rotation',
      resource: 'JWT 签名密钥',
      ip: '192.168.1.100',
      status: 'success',
    },
    {
      id: 'log_002',
      time: '2026-08-20 13:15:10',
      user: 'security_bot',
      action: 'cert_renewal',
      resource: 'api.sleep-monitor.com',
      ip: '10.0.0.5',
      status: 'success',
    },
    {
      id: 'log_003',
      time: '2026-08-20 10:05:33',
      user: 'unknown',
      action: 'failed_login',
      resource: 'admin_panel',
      ip: '203.0.113.50',
      status: 'failed',
    },
    {
      id: 'log_004',
      time: '2026-08-19 16:45:12',
      user: 'operator_01',
      action: 'secret_access',
      resource: 'database_credentials',
      ip: '192.168.1.105',
      status: 'success',
    },
  ]);

  // 加载状态
  const [loading, setLoading] = useState(false);
  const [rotateModalVisible, setRotateModalVisible] = useState(false);
  const [selectedKey, setSelectedKey] = useState<any>(null);

  // 密钥表格列定义
  const keyColumns: ColumnsType<any> = [
    {
      title: '密钥名称',
      dataIndex: 'name',
      key: 'name',
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status) => {
        const statusMap: Record<string, { color: string; text: string }> = {
          active: { color: 'green', text: '活跃' },
          revoked: { color: 'red', text: '已吊销' },
          expired: { color: 'default', text: '已过期' },
        };
        const s = statusMap[status] || { color: 'default', text: status };
        return <Tag color={s.color}>{s.text}</Tag>;
      },
    },
    {
      title: '上次轮换',
      dataIndex: 'last_rotated',
      key: 'last_rotated',
    },
    {
      title: '下次轮换',
      dataIndex: 'next_rotation',
      key: 'next_rotation',
      render: (date, record) => {
        if (record.status !== 'active') return '-';
        const days = record.expires_in_days;
        if (days <= 7) {
          return <Text type="danger">{date} ({days}天后)</Text>;
        }
        return <Text>{date} ({days}天后)</Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Tooltip title="查看详情">
            <Button type="link" size="small" icon={<EyeOutlined />} />
          </Tooltip>
          {record.status === 'active' && (
            <Tooltip title="轮换密钥">
              <Button
                type="link"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => {
                  setSelectedKey(record);
                  setRotateModalVisible(true);
                }}
              />
            </Tooltip>
          )}
          {record.status === 'active' && (
            <Popconfirm
              title="确定要吊销此密钥吗？"
              description="吊销后使用此密钥的服务将无法正常工作，请确保已完成轮换。"
              onConfirm={() => message.success('密钥已吊销')}
            >
              <Tooltip title="吊销密钥">
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  // 证书表格列定义
  const certColumns: ColumnsType<any> = [
    {
      title: '证书名称',
      dataIndex: 'name',
      key: 'name',
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
    },
    {
      title: '颁发者',
      dataIndex: 'issuer',
      key: 'issuer',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status) => {
        const statusMap: Record<string, { color: string; text: string }> = {
          valid: { color: 'green', text: '有效' },
          expiring_soon: { color: 'orange', text: '即将过期' },
          expired: { color: 'red', text: '已过期' },
          revoked: { color: 'red', text: '已吊销' },
        };
        const s = statusMap[status] || { color: 'default', text: status };
        return <Tag color={s.color}>{s.text}</Tag>;
      },
    },
    {
      title: '到期时间',
      dataIndex: 'expires_at',
      key: 'expires_at',
      render: (date, record) => {
        const days = record.expires_in_days;
        if (days <= 7) {
          return <Text type="danger">{date} ({days}天后)</Text>;
        }
        if (days <= 30) {
          return <Text type="warning">{date} ({days}天后)</Text>;
        }
        return <Text>{date} ({days}天后)</Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Tooltip title="查看详情">
            <Button type="link" size="small" icon={<EyeOutlined />} />
          </Tooltip>
          {record.status !== 'expired' && (
            <Tooltip title="续期证书">
              <Button type="link" size="small" icon={<ReloadOutlined />} />
            </Tooltip>
          )}
          <Tooltip title="下载证书">
            <Button type="link" size="small" icon={<DownloadOutlined />} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  // 审计日志表格列定义
  const auditColumns: ColumnsType<any> = [
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 180,
    },
    {
      title: '用户',
      dataIndex: 'user',
      key: 'user',
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      render: (action) => {
        const actionMap: Record<string, string> = {
          key_rotation: '密钥轮换',
          cert_renewal: '证书续期',
          failed_login: '登录失败',
          secret_access: '密钥访问',
          permission_change: '权限变更',
        };
        return actionMap[action] || action;
      },
    },
    {
      title: '资源',
      dataIndex: 'resource',
      key: 'resource',
    },
    {
      title: 'IP 地址',
      dataIndex: 'ip',
      key: 'ip',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status) => (
        <Tag color={status === 'success' ? 'green' : 'red'}>
          {status === 'success' ? '成功' : '失败'}
        </Tag>
      ),
    },
  ];

  // 安全评分颜色
  const getScoreColor = (score: number) => {
    if (score >= 90) return '#52c41a';
    if (score >= 70) return '#faad14';
    return '#ff4d4f';
  };

  return (
    <div style={{ padding: '24px' }}>
      {/* 页面标题 */}
      <div style={{ marginBottom: '24px' }}>
        <Title level={3} style={{ margin: 0 }}>
          <SafetyCertificateOutlined style={{ marginRight: '8px' }} />
          安全中心
        </Title>
        <Text type="secondary">管理密钥、证书、审计日志和安全配置</Text>
      </div>

      {/* 安全概览 */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="安全评分"
              value={securityScore}
              suffix="/ 100"
              valueStyle={{ color: getScoreColor(securityScore) }}
              prefix={<ShieldOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="严重风险"
              value={riskStats.critical}
              valueStyle={{ color: riskStats.critical > 0 ? '#ff4d4f' : '#52c41a' }}
              prefix={<ExclamationCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="高风险"
              value={riskStats.high}
              valueStyle={{ color: riskStats.high > 0 ? '#fa8c16' : '#52c41a' }}
              prefix={<WarningOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="活跃密钥"
              value={keys.filter((k) => k.status === 'active').length}
              prefix={<KeyOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* 标签页 */}
      <Card>
        <Tabs defaultActiveKey="keys">
          {/* 密钥管理 */}
          <TabPane
            tab={
              <span>
                <KeyOutlined />
                密钥管理
              </span>
            }
            key="keys"
          >
            <div style={{ marginBottom: '16px' }}>
              <Space>
                <Button type="primary" icon={<ReloadOutlined />}>
                  刷新
                </Button>
                <Button icon={<DownloadOutlined />}>导出密钥清单</Button>
              </Space>
            </div>
            <Table
              columns={keyColumns}
              dataSource={keys}
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: 10 }}
            />
          </TabPane>

          {/* 证书管理 */}
          <TabPane
            tab={
              <span>
                <SafetyCertificateOutlined />
                证书管理
              </span>
            }
            key="certs"
          >
            <div style={{ marginBottom: '16px' }}>
              <Space>
                <Button type="primary" icon={<ReloadOutlined />}>
                  刷新
                </Button>
                <Button icon={<DownloadOutlined />}>导出证书清单</Button>
              </Space>
            </div>
            <Table
              columns={certColumns}
              dataSource={certificates}
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: 10 }}
            />
          </TabPane>

          {/* 访问审计 */}
          <TabPane
            tab={
              <span>
                <EyeOutlined />
                访问审计
              </span>
            }
            key="audit"
          >
            <div style={{ marginBottom: '16px' }}>
              <Space>
                <Input.Search
                  placeholder="搜索用户/操作/资源"
                  style={{ width: 300 }}
                  allowClear
                />
                <Select
                  placeholder="操作类型"
                  style={{ width: 150 }}
                  allowClear
                  options={[
                    { value: 'key_rotation', label: '密钥轮换' },
                    { value: 'cert_renewal', label: '证书续期' },
                    { value: 'failed_login', label: '登录失败' },
                    { value: 'secret_access', label: '密钥访问' },
                  ]}
                />
                <DatePicker.RangePicker />
                <Button type="primary">查询</Button>
                <Button icon={<DownloadOutlined />}>导出日志</Button>
              </Space>
            </div>
            <Table
              columns={auditColumns}
              dataSource={auditLogs}
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: 10 }}
            />
          </TabPane>

          {/* 合规检查 */}
          <TabPane
            tab={
              <span>
                <LockOutlined />
                合规检查
              </span>
            }
            key="compliance"
          >
            <Descriptions
              title="安全配置检查结果"
              bordered
              column={1}
              style={{ marginBottom: '24px' }}
            >
              <Descriptions.Item label="TLS 配置">
                <Tag color="green">通过</Tag> - 已启用 TLS 1.2+，禁用弱密码套件
              </Descriptions.Item>
              <Descriptions.Item label="密码策略">
                <Tag color="green">通过</Tag> - 最小长度 12 位，包含大小写字母、数字、特殊字符
              </Descriptions.Item>
              <Descriptions.Item label="多因素认证">
                <Tag color="green">通过</Tag> - 管理员账户已强制启用 MFA
              </Descriptions.Item>
              <Descriptions.Item label="审计日志">
                <Tag color="green">通过</Tag> - 已启用全量审计日志，保留期 5 年
              </Descriptions.Item>
              <Descriptions.Item label="数据加密">
                <Tag color="green">通过</Tag> - 传输加密（TLS）+ 存储加密（AES-256）
              </Descriptions.Item>
              <Descriptions.Item label="密钥轮换">
                <Tag color="orange">警告</Tag> - JWT 签名密钥将在 7 天后到期，请及时轮换
              </Descriptions.Item>
              <Descriptions.Item label="证书到期">
                <Tag color="red">不通过</Tag> - old.sleep-monitor.com 证书将在 3 天后到期
              </Descriptions.Item>
            </Descriptions>
            <Button type="primary" icon={<ReloadOutlined />}>
              重新检查
            </Button>
          </TabPane>
        </Tabs>
      </Card>

      {/* 密钥轮换确认弹窗 */}
      <Modal
        title="轮换密钥"
        open={rotateModalVisible}
        onCancel={() => setRotateModalVisible(false)}
        onOk={() => {
          message.success('密钥轮换成功');
          setRotateModalVisible(false);
        }}
        okText="确认轮换"
        cancelText="取消"
      >
        {selectedKey && (
          <div>
            <Paragraph>
              确定要轮换密钥 <Text strong>{selectedKey.name}</Text> 吗？
            </Paragraph>
            <Alert
              message="轮换后，旧密钥将继续有效 24 小时用于平滑过渡，请确保所有服务已更新到新密钥。"
              type="warning"
              showIcon
            />
          </div>
        )}
      </Modal>
    </div>
  );
};

export default SecurityCenter;
