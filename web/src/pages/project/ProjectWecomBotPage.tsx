import { useEffect, useState } from 'react';
import { Badge, Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, Icon, Modal, PageHead, Skeleton, useToast, type Tone } from '@ui';
import { api, type ProjectWecomBot, type ProjectWecomBotRegistration } from '../../lib/api.ts';
import { fmtDateTime, fmtRelative } from '../../lib/format.ts';
import { useAsync } from '../../lib/hooks.ts';
import { useProject } from '../ProjectLayout.tsx';

function statusMeta(status: string): { label: string; tone: Tone } {
  if (status === 'online') return { label: '在线', tone: 'green' };
  if (status === 'connecting') return { label: '连接中', tone: 'amber' };
  if (status === 'error') return { label: '连接异常', tone: 'red' };
  return { label: '已保存', tone: 'slate' };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** 项目企业微信机器人：扫码注册后，企微消息会进入该项目的任务队列。 */
export function ProjectWecomBotPage() {
  const { detail } = useProject();
  const project = detail.project;
  const toast = useToast();
  const botQuery = useAsync(() => api.projectWecomBot(project.id), [project.id]);
  const [registration, setRegistration] = useState<ProjectWecomBotRegistration | null>(null);
  const [registrationStatus, setRegistrationStatus] = useState<string>('pending');
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [connectingMock, setConnectingMock] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const bot = botQuery.data?.bot ?? null;

  const startRegistration = async (): Promise<void> => {
    setStarting(true);
    setRegistrationError(null);
    try {
      const result = await api.startProjectWecomBotRegistration(project.id);
      setRegistration(result);
      setRegistrationStatus(result.status);
    } catch (cause) {
      const message = errorMessage(cause, '无法生成企业微信机器人二维码');
      setRegistrationError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!registration || ['success', 'expired', 'failed', 'cancelled'].includes(registrationStatus)) return;
    let cancelled = false;
    let timer = 0;
    const poll = async (): Promise<void> => {
      try {
        const result = await api.projectWecomBotRegistration(project.id, registration.attemptId);
        if (cancelled) return;
        setRegistrationStatus(result.status);
        if (result.status === 'success') {
          toast.success('企业微信机器人已连接');
          await botQuery.refresh();
          return;
        }
        if (result.status === 'expired' || result.status === 'failed') {
          setRegistrationError(result.error ?? '二维码已过期，请重新生成');
          return;
        }
        timer = window.setTimeout(() => void poll(), Math.max(1_000, registration.pollIntervalMs));
      } catch (cause) {
        if (!cancelled) {
          setRegistrationError(errorMessage(cause, '扫码状态读取失败'));
          timer = window.setTimeout(() => void poll(), 5_000);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), Math.max(1_000, registration.pollIntervalMs));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [registration?.attemptId, registrationStatus, project.id]);

  const connectMock = async (): Promise<void> => {
    setConnectingMock(true);
    try {
      await api.connectMockProjectWecomBot(project.id);
      toast.success('已连接 Mock 企业微信机器人');
      await botQuery.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '连接 Mock 企业微信机器人失败'));
    } finally {
      setConnectingMock(false);
    }
  };

  const remove = async (): Promise<void> => {
    setRemoving(true);
    try {
      await api.deleteProjectWecomBot(project.id);
      toast.success('已解除企业微信机器人绑定');
      setConfirmRemove(false);
      await botQuery.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, '解除绑定失败'));
    } finally {
      setRemoving(false);
    }
  };

  const closeRegistration = (): void => {
    setRegistration(null);
    setRegistrationError(null);
    setRegistrationStatus('pending');
  };

  const status = bot ? statusMeta(bot.status) : null;
  const waiting = registrationStatus === 'pending' || registrationStatus === 'waiting';

  return (
    <div className="ws-page">
      <PageHead
        title="企业微信机器人"
        desc="为当前项目扫码注册企业微信机器人；仅已绑定 Ryan 账号的企业微信成员发消息时才会创建项目任务。"
        actions={(
          <div className="hstack gap-8">
            {botQuery.data?.mockAvailable ? (
              <Button variant="primary" icon="wechat" loading={connectingMock} onClick={() => void connectMock()}>
                {bot ? '重新连接 Mock' : '一键连接 Mock'}
              </Button>
            ) : null}
            {bot ? (
              <Button variant="outline" icon="refresh" loading={starting} onClick={() => void startRegistration()}>
                重新扫码绑定
              </Button>
            ) : null}
          </div>
        )}
      />

      <Callout tone="cyan" icon="wechat">
        无需配置 Corp ID 或 Secret：点击下方按钮后，用企业微信扫描二维码即可注册机器人。机器人凭据只保存在 Ryan 服务端。
        {botQuery.data?.mockAvailable ? ' 当前环境已检测到 Mock 企业微信，可以一键创建并连接。' : ''}
      </Callout>

      {botQuery.loading && !botQuery.data ? (
        <div className="vstack gap-8 mt-12"><Skeleton h={120} /><Skeleton h={120} /></div>
      ) : botQuery.error && !botQuery.data ? (
        <ErrorState message={botQuery.error} onRetry={() => void botQuery.refresh()} />
      ) : bot ? (
        <Card className="card-pad mt-12">
          <div className="row-between gap-12 wrap">
            <div className="hstack gap-10">
              <span className="cx-metric-icon tone-green"><Icon name="wechat" size={16} /></span>
              <div>
                <div className="strong">项目企业微信机器人</div>
                <div className="tiny dim mono">{bot.remoteBotId}</div>
              </div>
            </div>
            <div className="hstack gap-8">
              <Badge tone={status?.tone} size="sm" dot>{status?.label}</Badge>
              <Button size="sm" variant="ghost" icon="trash" loading={removing} onClick={() => setConfirmRemove(true)}>解除绑定</Button>
            </div>
          </div>
          <div className="grid grid-3 mt-12">
            <div><div className="tiny dim">创建时间</div><div className="small">{fmtDateTime(bot.createdAt)}</div></div>
            <div><div className="tiny dim">最近连接</div><div className="small">{bot.connectedAt ? fmtRelative(bot.connectedAt) : '尚未连接'}</div></div>
            <div><div className="tiny dim">接收范围</div><div className="small">{project.name}</div></div>
          </div>
          <Callout tone="slate" icon="info">
            只有在企业微信 userid 已绑定 Ryan 账号且拥有该项目权限时，消息才会创建任务；未绑定发送者会收到拒收提示。
          </Callout>
        </Card>
      ) : (
        <Card className="card-pad mt-12">
          <EmptyState
            icon="wechat"
            title="还没有绑定企业微信机器人"
            description="扫码后，机器人会接入当前项目。企业微信消息会自动转成项目任务。"
            action={<div className="hstack gap-8"><Button variant="primary" icon="wechat" loading={starting} onClick={() => void startRegistration()}>扫码注册机器人</Button>{botQuery.data?.mockAvailable ? <Button variant="outline" icon="wechat" loading={connectingMock} onClick={() => void connectMock()}>一键连接 Mock</Button> : null}</div>}
          />
        </Card>
      )}

      <Modal
        open={Boolean(registration)}
        onClose={closeRegistration}
        title="扫码注册企业微信机器人"
        description={`为项目「${project.name}」注册机器人；二维码有效期约 5 分钟。`}
        size="sm"
        footer={<Button variant="ghost" onClick={closeRegistration}>关闭</Button>}
      >
        {registrationError ? (
          <Callout tone="red" icon="xCircle">
            {registrationError}
            {registration ? <div className="mt-8"><Button size="sm" variant="outline" icon="refresh" onClick={() => void startRegistration()}>重新生成二维码</Button></div> : null}
          </Callout>
        ) : registration ? (
          <div className="vstack gap-12" style={{ alignItems: 'center' }}>
            <img src={registration.qrCodeDataUrl} alt="企业微信机器人注册二维码" style={{ width: 260, height: 260, borderRadius: 10 }} />
            <Badge tone={registrationStatus === 'success' ? 'green' : waiting ? 'amber' : 'slate'} size="sm" dot>
              {registrationStatus === 'success' ? '已连接' : waiting ? '等待扫码…' : registrationStatus}
            </Badge>
            <div className="tiny dim center">使用企业微信扫描二维码，按提示完成机器人注册。</div>
            <a className="tiny dim" href={registration.authUrl} target="_blank" rel="noreferrer">在企业微信中打开</a>
          </div>
        ) : (
          <Skeleton h={260} />
        )}
      </Modal>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
        loading={removing}
        title="解除企业微信机器人绑定？"
        description="解除后将停止接收该机器人的消息；已创建的项目任务不受影响。"
        confirmLabel="解除绑定"
      />
    </div>
  );
}
