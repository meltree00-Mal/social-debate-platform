import { useState, useEffect, useRef } from 'react'
import './App.css'
import { supabase, isSupabaseEnabled } from './lib/supabase'

interface User {
  id: number;
  name: string;
  email: string;
  password: string;
  isAdmin: boolean;
  isActive: boolean;
  credit: number;
  creditHistory: CreditRecord[];
}

interface CreditRecord {
  id: number;
  delta: number;
  reason: string;
  balanceAfter: number;
  createdAt: number;
}

interface ConfirmAction {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}

interface PendingVoteChoice {
  marketId: number;
  outcome: 'yes' | 'no';
  mode: 'new' | 'edit';
  previousAmount?: number;
}

interface LoadingState {
  type: 'market' | 'secret' | 'vote' | 'secret-view' | 'settlement' | 'revoke';
  title: string;
  message: string;
}

interface Secret {
  id: number;
  title: string;
  content: string;
  author: string;
  price: number;
  imageUrl?: string;
  createdAt: number;
  ratings: { user: string; authenticity: '真实' | '不真实'; value: '值得' | '不值得' }[];
}

interface Market {
  id: number;
  question: string;
  tag: '政治' | '经济' | '生活';
  createdAt: number;
  participants: string[];
  followers: string[];
  voteRecords: {
    id: number;
    user: string;
    outcome: 'yes' | 'no';
    amount: number;
    createdAt: number;
    status: 'active' | 'revoked';
    revokedAt?: number;
  }[];
  resultFeedbacks: {
    user: string;
    stance: 'accept' | 'verify';
    createdAt: number;
  }[];
  b: number;
  yesShares: number;
  noShares: number;
  yesPrice: number;
  noPrice: number;
  creator: string;
  deadline: string;
  pinnedAt?: number;
  resolvedOutcome?: 'yes' | 'no';
  resolvedAt?: number;
}

interface Feedback {
  id: number;
  userName: string;
  content: string;
  imageUrl?: string;
  createdAt: number;
  status: 'unread' | 'read';
}

interface SharedAppState {
  users: User[];
  markets: Market[];
  secrets: Secret[];
  feedbacks: Feedback[];
  publicAnnouncement: string;
  testInviteCode: string;
}

type SharedCollectionKey = 'users' | 'markets' | 'secrets' | 'feedbacks' | 'settings';

type SharedVersions = Record<SharedCollectionKey, number>;

interface SharedSettingsState {
  publicAnnouncement: string;
  testInviteCode: string;
}

interface RemoteDocument<TPayload> {
  payload: TPayload;
  version: number;
  updated_at: string;
}

interface PullSharedStateResult {
  payload: Partial<SharedAppState>;
  versions: SharedVersions;
  maxUpdatedAt: number;
}

type PersistDocStatus = 'ok' | 'conflict' | 'error';

const initialMarkets: Market[] = [
  { id: 1, question: "Will it rain tomorrow?", tag: '生活', createdAt: Date.now() - 2 * 60 * 1000, participants: [], followers: [], voteRecords: [], resultFeedbacks: [], b: 100, yesShares: 0, noShares: 0, yesPrice: 1, noPrice: 1, creator: "Admin", deadline: "2026-03-20" },
  { id: 2, question: "Will the stock market go up next week?", tag: '经济', createdAt: Date.now() - 1 * 60 * 1000, participants: [], followers: [], voteRecords: [], resultFeedbacks: [], b: 100, yesShares: 0, noShares: 0, yesPrice: 1, noPrice: 1, creator: "Admin", deadline: "2026-03-21" },
];

const calculatePrices = (market: Market) => {
  const expYes = Math.exp(market.yesShares / market.b);
  const expNo = Math.exp(market.noShares / market.b);
  const sum = expYes + expNo;
  market.yesPrice = expYes / sum;
  market.noPrice = expNo / sum;
};

const scoreFromRating = (rating: { authenticity: '真实' | '不真实'; value: '值得' | '不值得' } | undefined) => {
  if (!rating) return 0;
  if (rating.authenticity === '真实' && rating.value === '值得') return 10;
  if (rating.authenticity === '真实' || rating.value === '值得') return 5;
  return 0;
};

const PREDICTION_PUBLISH_FEE = 10;
const SECRET_PUBLISH_FEE = 20;
const VOTE_AMOUNT_OPTIONS = [1, 10, 100] as const;
const HOME_LOGO_URL = '/social-duixian-logo.png?v=20260317-1';

const SHARED_TABLES: Record<SharedCollectionKey, string> = {
  users: 'shared_users',
  markets: 'shared_markets',
  secrets: 'shared_secrets',
  feedbacks: 'shared_feedbacks',
  settings: 'shared_settings',
};

const emptyVersions = (): SharedVersions => ({
  users: 0,
  markets: 0,
  secrets: 0,
  feedbacks: 0,
  settings: 0,
});

function App() {
  const remoteHydratingRef = useRef(false);
  const remoteSavingRef = useRef(false);
  const lastLocalMutationAtRef = useRef(0);
  const remoteVersionsRef = useRef<SharedVersions>(emptyVersions());
  const lastPersistConflictAtRef = useRef(0);
  const currentUserRef = useRef<User | null>(null);
  const [hasCompletedInitialRemoteSync, setHasCompletedInitialRemoteSync] = useState(!isSupabaseEnabled);

  const normalizeMarket = (market: Partial<Market>): Market => {
    const normalizedVoteRecords: Market['voteRecords'] = Array.isArray(market.voteRecords)
      ? market.voteRecords
        .filter(record => (
          Boolean(record)
          && typeof record.user === 'string'
          && (record.outcome === 'yes' || record.outcome === 'no')
          && typeof record.createdAt === 'number'
        ))
        .map(record => ({
          id: typeof record.id === 'number' ? record.id : record.createdAt,
          user: record.user,
          outcome: record.outcome,
          amount: typeof record.amount === 'number' && record.amount > 0 ? record.amount : 1,
          createdAt: record.createdAt,
          status: record.status === 'revoked' ? 'revoked' : 'active',
          revokedAt: typeof record.revokedAt === 'number' ? record.revokedAt : undefined,
        }))
      : [];

    const activeVoteRecords = normalizedVoteRecords.filter(record => record.status === 'active');
    const yesStake = activeVoteRecords
      .filter(record => record.outcome === 'yes')
      .reduce((sum, record) => sum + record.amount, 0);
    const noStake = activeVoteRecords
      .filter(record => record.outcome === 'no')
      .reduce((sum, record) => sum + record.amount, 0);

    return {
      id: typeof market.id === 'number' ? market.id : Date.now(),
      question: typeof market.question === 'string' ? market.question : 'Untitled prediction',
      tag: market.tag === '政治' || market.tag === '经济' || market.tag === '生活' ? market.tag : '生活',
      createdAt: typeof market.createdAt === 'number'
        ? market.createdAt
        : (typeof market.id === 'number' ? market.id : Date.now()),
      participants: Array.isArray(market.participants)
        ? market.participants.filter((name): name is string => typeof name === 'string')
        : [],
      followers: Array.isArray(market.followers)
        ? market.followers.filter((name): name is string => typeof name === 'string')
        : [],
      voteRecords: normalizedVoteRecords,
      resultFeedbacks: Array.isArray(market.resultFeedbacks)
        ? market.resultFeedbacks
          .filter(item => (
            Boolean(item)
            && typeof item.user === 'string'
            && (item.stance === 'accept' || item.stance === 'verify')
            && typeof item.createdAt === 'number'
          ))
          .map(item => ({
            user: item.user,
            stance: item.stance,
            createdAt: item.createdAt,
          }))
        : [],
      b: typeof market.b === 'number' ? market.b : 100,
      yesShares: yesStake,
      noShares: noStake,
      yesPrice: typeof market.yesPrice === 'number' ? market.yesPrice : 0,
      noPrice: typeof market.noPrice === 'number' ? market.noPrice : 0,
      creator: typeof market.creator === 'string' ? market.creator : 'Unknown',
      deadline: typeof market.deadline === 'string' ? market.deadline : '',
      pinnedAt: typeof market.pinnedAt === 'number' ? market.pinnedAt : undefined,
      resolvedOutcome: market.resolvedOutcome === 'yes' || market.resolvedOutcome === 'no' ? market.resolvedOutcome : undefined,
      resolvedAt: typeof market.resolvedAt === 'number' ? market.resolvedAt : undefined,
    };
  };

  const normalizeSecret = (secret: Partial<Secret>): Secret => {
    const rawRatings = Array.isArray(secret.ratings) ? secret.ratings : [];
    const normalizedRatings = rawRatings.filter(
      (rating): rating is { user: string; authenticity: '真实' | '不真实'; value: '值得' | '不值得' } =>
        Boolean(rating && typeof rating.user === 'string')
        && (rating.authenticity === '真实' || rating.authenticity === '不真实')
        && (rating.value === '值得' || rating.value === '不值得')
    );

    return {
      id: typeof secret.id === 'number' ? secret.id : Date.now(),
      title: typeof secret.title === 'string' ? secret.title : 'Untitled',
      content: typeof secret.content === 'string' ? secret.content : '',
      author: typeof secret.author === 'string' ? secret.author : 'Unknown',
      price: typeof secret.price === 'number' ? secret.price : 1,
      imageUrl: typeof secret.imageUrl === 'string' ? secret.imageUrl : undefined,
      createdAt: typeof secret.createdAt === 'number'
        ? secret.createdAt
        : (typeof secret.id === 'number' ? secret.id : Date.now()),
      ratings: normalizedRatings,
    };
  };

  const legacyBalance = (() => {
    const saved = localStorage.getItem('balance');
    return saved ? parseFloat(saved) : 1000;
  })();
  const normalizeUser = (user: Partial<User> & { points?: number }): User => {
    const normalizedCredit = typeof user.credit === 'number'
      ? user.credit
      : (typeof user.points === 'number' ? user.points + legacyBalance : legacyBalance);

    const history = Array.isArray(user.creditHistory)
      ? user.creditHistory.filter(item => (
        item
        && typeof item.id === 'number'
        && typeof item.delta === 'number'
        && typeof item.reason === 'string'
        && typeof item.balanceAfter === 'number'
        && typeof item.createdAt === 'number'
      ))
      : [];

    return {
      id: typeof user.id === 'number' ? user.id : Date.now(),
      name: typeof user.name === 'string' ? user.name : `user-${Date.now()}`,
      email: typeof user.email === 'string' ? user.email : '',
      password: typeof user.password === 'string' ? user.password : '',
      isAdmin: Boolean(user.isAdmin) || (typeof user.name === 'string' && user.name.trim().toLowerCase() === 'admin'),
      isActive: typeof user.isActive === 'boolean' ? user.isActive : true,
      credit: normalizedCredit,
      creditHistory: history,
    };
  };
  const [users, setUsers] = useState<User[]>(() => {
    const saved = localStorage.getItem('users');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeUser);
    } catch {
      return [];
    }
  });
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const savedLoginName = localStorage.getItem('currentUserName');
    if (!savedLoginName) return null;
    const matchedUser = users.find(user => user.name.trim().toLowerCase() === savedLoginName.trim().toLowerCase());
    return matchedUser?.isActive ? matchedUser : null;
  });
  const [loginName, setLoginName] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [newQuestion, setNewQuestion] = useState('');
  const [newTag, setNewTag] = useState<'政治' | '经济' | '生活'>('政治');
  const [newDeadline, setNewDeadline] = useState('');
  const [editingMarket, setEditingMarket] = useState<Market | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [activeTab, setActiveTab] = useState<'truth' | 'secret' | 'credit' | 'account' | 'admin' | 'feedback'>('truth');
  const [newTitle, setNewTitle] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [newSecretImage, setNewSecretImage] = useState<string | null>(null);
  const [newSecretPrice, setNewSecretPrice] = useState(1);
  const [marketKeyword, setMarketKeyword] = useState('');
  const [marketTagFilter, setMarketTagFilter] = useState<'all' | '政治' | '经济' | '生活'>('all');
  const [marketDeadlineFilter, setMarketDeadlineFilter] = useState<'all' | 'upcoming' | 'soon' | 'expired'>('all');
  const [marketDeadlineDate, setMarketDeadlineDate] = useState('');
  const [marketScopeFilter, setMarketScopeFilter] = useState<'all' | 'mine' | 'participated' | 'followed'>('all');
  const [secrets, setSecrets] = useState<Secret[]>(() => {
    const saved = localStorage.getItem('secrets');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeSecret);
    } catch {
      return [];
    }
  });
  const [viewedSecrets, setViewedSecrets] = useState<Set<number>>(new Set());
  const [showRecharge, setShowRecharge] = useState(false);
  const [editingSecret, setEditingSecret] = useState<Secret | null>(null);
  const [editSecretTitle, setEditSecretTitle] = useState('');
  const [editSecretContent, setEditSecretContent] = useState('');
  const [editSecretImage, setEditSecretImage] = useState<string | null>(null);
  const [editSecretPrice, setEditSecretPrice] = useState(1);
  const [secretSort, setSecretSort] = useState<'latest' | 'oldest' | 'price-high' | 'price-low'>('latest');
  const [secretTimeFilter, setSecretTimeFilter] = useState<'all' | 'today' | 'week'>('all');
  const [creditHistoryFilter, setCreditHistoryFilter] = useState<'all' | 'recharge' | 'publish' | 'vote' | 'secret-income' | 'other'>('all');
  const [pendingAction, setPendingAction] = useState<ConfirmAction | null>(null);
  const [pendingVoteChoice, setPendingVoteChoice] = useState<PendingVoteChoice | null>(null);
  const [marketDetailId, setMarketDetailId] = useState<number | null>(null);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<number, string>>({});
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmNewPasswordInput, setConfirmNewPasswordInput] = useState('');
  const [feedbackContent, setFeedbackContent] = useState('');
  const [feedbackImage, setFeedbackImage] = useState<string | null>(null);
  const [feedbacks, setFeedbacks] = useState<Feedback[]>(() => {
    const saved = localStorage.getItem('feedbacks');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [publicAnnouncement, setPublicAnnouncement] = useState(() => localStorage.getItem('publicAnnouncement') ?? '欢迎来到社交对线平台内测，欢迎提出改进建议。');
  const [testInviteCode, setTestInviteCode] = useState(() => localStorage.getItem('testInviteCode') ?? '');
  const [announcementDraft, setAnnouncementDraft] = useState(() => localStorage.getItem('publicAnnouncement') ?? '欢迎来到社交对线平台内测，欢迎提出改进建议。');
  const [inviteCodeDraft, setInviteCodeDraft] = useState(() => localStorage.getItem('testInviteCode') ?? '');
  const [markets, setMarkets] = useState<Market[]>(() => {
    const saved = localStorage.getItem('markets');
    if (saved) {
      const parsed = JSON.parse(saved);
      const m = Array.isArray(parsed) ? parsed.map(normalizeMarket) : [];
      m.forEach((market: Market) => calculatePrices(market));
      return m;
    }
    const m = initialMarkets.map(market => ({ ...market }));
    m.forEach(calculatePrices);
    return m;
  });
  const [loadingState, setLoadingState] = useState<LoadingState | null>(null);

  const applySharedState = (data: Partial<SharedAppState>) => {
    remoteHydratingRef.current = true;

    if (Array.isArray(data.users)) {
      setUsers(data.users.map(normalizeUser));
    }
    if (Array.isArray(data.markets)) {
      const nextMarkets = data.markets.map(normalizeMarket);
      nextMarkets.forEach((market: Market) => calculatePrices(market));
      setMarkets(nextMarkets);
    }
    if (Array.isArray(data.secrets)) {
      setSecrets(data.secrets.map(normalizeSecret));
    }
    if (Array.isArray(data.feedbacks)) {
      setFeedbacks(data.feedbacks as Feedback[]);
    }
    if (typeof data.publicAnnouncement === 'string') {
      setPublicAnnouncement(data.publicAnnouncement);
      setAnnouncementDraft(data.publicAnnouncement);
    }
    if (typeof data.testInviteCode === 'string') {
      setTestInviteCode(data.testInviteCode);
      setInviteCodeDraft(data.testInviteCode);
    }

    window.setTimeout(() => {
      remoteHydratingRef.current = false;
    }, 0);
  };

  const isDangerousEmptySnapshot = (localSnapshot: SharedAppState, remotePayload: Partial<SharedAppState>) => {
    const localTotalCount = localSnapshot.users.length
      + localSnapshot.markets.length
      + localSnapshot.secrets.length
      + localSnapshot.feedbacks.length;

    const hasLocalData = localTotalCount > 0;
    const hasIncomingCollection = ['users', 'markets', 'secrets', 'feedbacks'].some((key) => key in remotePayload);

    if (!hasLocalData || !hasIncomingCollection) {
      return false;
    }

    const incomingUsers = Array.isArray(remotePayload.users) ? remotePayload.users.length : localSnapshot.users.length;
    const incomingMarkets = Array.isArray(remotePayload.markets) ? remotePayload.markets.length : localSnapshot.markets.length;
    const incomingSecrets = Array.isArray(remotePayload.secrets) ? remotePayload.secrets.length : localSnapshot.secrets.length;
    const incomingFeedbacks = Array.isArray(remotePayload.feedbacks) ? remotePayload.feedbacks.length : localSnapshot.feedbacks.length;

    return incomingUsers + incomingMarkets + incomingSecrets + incomingFeedbacks === 0;
  };

  const applyRemoteSharedState = (remotePayload: Partial<SharedAppState>, remoteUpdatedAt: number, force = false) => {
    if (!force && remoteUpdatedAt > 0 && remoteUpdatedAt <= lastLocalMutationAtRef.current) {
      setHasCompletedInitialRemoteSync(true);
      return false;
    }

    const localSnapshot: SharedAppState = {
      users,
      markets,
      secrets,
      feedbacks,
      publicAnnouncement,
      testInviteCode,
    };

    if (!force && isDangerousEmptySnapshot(localSnapshot, remotePayload)) {
      setHasCompletedInitialRemoteSync(true);
      return false;
    }

    const activeUser = currentUserRef.current;
    if (activeUser && Array.isArray(remotePayload.users)) {
      const stillExists = remotePayload.users.some(user =>
        (typeof user.id === 'number' && user.id === activeUser.id)
        || (typeof user.name === 'string' && user.name.trim().toLowerCase() === activeUser.name.trim().toLowerCase())
      );

      if (!stillExists) {
        setHasCompletedInitialRemoteSync(true);
        return false;
      }
    }

    applySharedState(remotePayload);
    setHasCompletedInitialRemoteSync(true);
    return true;
  };

  const pullSharedDocuments = async (): Promise<PullSharedStateResult | null> => {
    if (!isSupabaseEnabled || !supabase) return null;

    const client = supabase;
    const [usersRes, marketsRes, secretsRes, feedbacksRes, settingsRes] = await Promise.all([
      client.from(SHARED_TABLES.users).select('payload,version,updated_at').eq('id', 1).maybeSingle(),
      client.from(SHARED_TABLES.markets).select('payload,version,updated_at').eq('id', 1).maybeSingle(),
      client.from(SHARED_TABLES.secrets).select('payload,version,updated_at').eq('id', 1).maybeSingle(),
      client.from(SHARED_TABLES.feedbacks).select('payload,version,updated_at').eq('id', 1).maybeSingle(),
      client.from(SHARED_TABLES.settings).select('payload,version,updated_at').eq('id', 1).maybeSingle(),
    ]);

    const responses = [usersRes, marketsRes, secretsRes, feedbacksRes, settingsRes];
    const hasSchemaError = responses.some(res => Boolean(res.error));
    if (hasSchemaError) {
      return null;
    }

    const usersDoc = usersRes.data as RemoteDocument<Partial<User>[]> | null;
    const marketsDoc = marketsRes.data as RemoteDocument<Partial<Market>[]> | null;
    const secretsDoc = secretsRes.data as RemoteDocument<Partial<Secret>[]> | null;
    const feedbacksDoc = feedbacksRes.data as RemoteDocument<Feedback[]> | null;
    const settingsDoc = settingsRes.data as RemoteDocument<SharedSettingsState> | null;

    const payload: Partial<SharedAppState> = {};

    if (usersDoc && Array.isArray(usersDoc.payload)) {
      payload.users = usersDoc.payload.map(normalizeUser);
    }
    if (marketsDoc && Array.isArray(marketsDoc.payload)) {
      const normalizedMarkets = marketsDoc.payload.map(normalizeMarket);
      normalizedMarkets.forEach((market: Market) => calculatePrices(market));
      payload.markets = normalizedMarkets;
    }
    if (secretsDoc && Array.isArray(secretsDoc.payload)) {
      payload.secrets = secretsDoc.payload.map(normalizeSecret);
    }
    if (feedbacksDoc && Array.isArray(feedbacksDoc.payload)) {
      payload.feedbacks = feedbacksDoc.payload;
    }
    if (settingsDoc?.payload && typeof settingsDoc.payload === 'object') {
      if (typeof settingsDoc.payload.publicAnnouncement === 'string') {
        payload.publicAnnouncement = settingsDoc.payload.publicAnnouncement;
      }
      if (typeof settingsDoc.payload.testInviteCode === 'string') {
        payload.testInviteCode = settingsDoc.payload.testInviteCode;
      }
    }

    const versions: SharedVersions = {
      users: usersDoc?.version ?? 0,
      markets: marketsDoc?.version ?? 0,
      secrets: secretsDoc?.version ?? 0,
      feedbacks: feedbacksDoc?.version ?? 0,
      settings: settingsDoc?.version ?? 0,
    };

    const maxUpdatedAt = [usersDoc, marketsDoc, secretsDoc, feedbacksDoc, settingsDoc]
      .map(doc => (doc?.updated_at ? new Date(doc.updated_at).getTime() : 0))
      .reduce((max, value) => Math.max(max, value), 0);

    return { payload, versions, maxUpdatedAt };
  };

  const pullSharedState = async (force = false) => {
    if (!isSupabaseEnabled || !supabase) return;

    const pulled = await pullSharedDocuments();
    if (!pulled) {
      setHasCompletedInitialRemoteSync(true);
      return;
    }

    remoteVersionsRef.current = pulled.versions;
    if (Object.keys(pulled.payload).length > 0) {
      applyRemoteSharedState(pulled.payload, pulled.maxUpdatedAt, force);
      return;
    }

    setHasCompletedInitialRemoteSync(true);
  };

  const buildSharedStatePayload = (overrides: Partial<SharedAppState> = {}): SharedAppState => ({
    users: overrides.users ?? users,
    markets: overrides.markets ?? markets,
    secrets: overrides.secrets ?? secrets,
    feedbacks: overrides.feedbacks ?? feedbacks,
    publicAnnouncement: overrides.publicAnnouncement ?? publicAnnouncement,
    testInviteCode: overrides.testInviteCode ?? testInviteCode,
  });

  const getSyncFailureMessage = (defaultMessage: string) => {
    const justHadConflict = Date.now() - lastPersistConflictAtRef.current <= 5000;
    if (justHadConflict) {
      return '检测到并发更新，已自动拉取最新数据。请重试一次以完成操作。';
    }
    return defaultMessage;
  };

  const logSyncConflict = (tableName: string, attemptedVersion: number) => {
    if (!supabase) return;
    const userName = currentUserRef.current?.name ?? null;
    void supabase
      .from('sync_conflict_log')
      .insert({ table_name: tableName, attempted_version: attemptedVersion, user_name: userName, occurred_at: new Date().toISOString() });
  };

  const persistDocumentWithVersion = async <TPayload,>(
    tableName: string,
    key: SharedCollectionKey,
    payload: TPayload,
  ): Promise<PersistDocStatus> => {
    if (!supabase) return 'error';

    const client = supabase;
    const nowIso = new Date().toISOString();

    const { data: currentRow, error: currentError } = await client
      .from(tableName)
      .select('version')
      .eq('id', 1)
      .maybeSingle();

    if (currentError) {
      return 'error';
    }

    const currentVersion = typeof currentRow?.version === 'number' ? currentRow.version : 0;
    const nextVersion = currentVersion + 1;

    if (currentVersion === 0) {
      const { error: insertError } = await client
        .from(tableName)
        .upsert({ id: 1, payload, version: 1, updated_at: nowIso }, { onConflict: 'id' });

      if (insertError) {
        return 'error';
      }

      remoteVersionsRef.current[key] = 1;
      return 'ok';
    }

    const { data: updatedRow, error: updateError } = await client
      .from(tableName)
      .update({ payload, version: nextVersion, updated_at: nowIso })
      .eq('id', 1)
      .eq('version', currentVersion)
      .select('version')
      .maybeSingle();

    if (updateError) {
      return 'error';
    }

    if (!updatedRow || typeof updatedRow.version !== 'number') {
      logSyncConflict(tableName, currentVersion);
      return 'conflict';
    }

    remoteVersionsRef.current[key] = updatedRow.version;
    return 'ok';
  };

  const persistSharedState = async (overrides: Partial<SharedAppState> = {}, hasRetried = false): Promise<boolean> => {
    if (!isSupabaseEnabled || !supabase) {
      return true;
    }

    const nextSnapshot = buildSharedStatePayload(overrides);
    const existingTotalCount = users.length + markets.length + secrets.length + feedbacks.length;
    const nextTotalCount = nextSnapshot.users.length
      + nextSnapshot.markets.length
      + nextSnapshot.secrets.length
      + nextSnapshot.feedbacks.length;

    if (existingTotalCount > 0 && nextTotalCount === 0) {
      return false;
    }

    const shouldSaveUsers = Object.prototype.hasOwnProperty.call(overrides, 'users');
    const shouldSaveMarkets = Object.prototype.hasOwnProperty.call(overrides, 'markets');
    const shouldSaveSecrets = Object.prototype.hasOwnProperty.call(overrides, 'secrets');
    const shouldSaveFeedbacks = Object.prototype.hasOwnProperty.call(overrides, 'feedbacks');
    const shouldSaveSettings = Object.prototype.hasOwnProperty.call(overrides, 'publicAnnouncement')
      || Object.prototype.hasOwnProperty.call(overrides, 'testInviteCode');

    const saveAll = Object.keys(overrides).length === 0;

    remoteSavingRef.current = true;
    const updatedAt = new Date().toISOString();
    lastLocalMutationAtRef.current = new Date(updatedAt).getTime();

    const writeResults = await Promise.all([
      (saveAll || shouldSaveUsers)
        ? persistDocumentWithVersion(SHARED_TABLES.users, 'users', nextSnapshot.users)
        : Promise.resolve('ok' as PersistDocStatus),
      (saveAll || shouldSaveMarkets)
        ? persistDocumentWithVersion(SHARED_TABLES.markets, 'markets', nextSnapshot.markets)
        : Promise.resolve('ok' as PersistDocStatus),
      (saveAll || shouldSaveSecrets)
        ? persistDocumentWithVersion(SHARED_TABLES.secrets, 'secrets', nextSnapshot.secrets)
        : Promise.resolve('ok' as PersistDocStatus),
      (saveAll || shouldSaveFeedbacks)
        ? persistDocumentWithVersion(SHARED_TABLES.feedbacks, 'feedbacks', nextSnapshot.feedbacks)
        : Promise.resolve('ok' as PersistDocStatus),
      (saveAll || shouldSaveSettings)
        ? persistDocumentWithVersion(SHARED_TABLES.settings, 'settings', {
          publicAnnouncement: nextSnapshot.publicAnnouncement,
          testInviteCode: nextSnapshot.testInviteCode,
        } satisfies SharedSettingsState)
        : Promise.resolve('ok' as PersistDocStatus),
    ]);

    remoteSavingRef.current = false;

    const hasConflict = writeResults.some(result => result === 'conflict');
    const hasError = writeResults.some(result => result === 'error');

    if (hasConflict) {
      lastPersistConflictAtRef.current = Date.now();
      await pullSharedState(true);
      if (!hasRetried) {
        return persistSharedState(overrides, true);
      }
      return false;
    }

    if (hasError) {
      return false;
    }

    await pullSharedState(true);
    return true;
  };

  const applyCreditDelta = (
    userList: User[],
    userName: string,
    delta: number,
    reason: string,
    activeUserName?: string | null,
  ) => {
    const timestamp = Date.now();
    let nextCurrentUser: User | null = null;

    const nextUsers = userList.map(user => {
      if (user.name !== userName) return user;

      const balanceAfter = user.credit + delta;
      const record: CreditRecord = {
        id: timestamp + Math.floor(Math.random() * 1000),
        delta,
        reason,
        balanceAfter,
        createdAt: timestamp,
      };

      const nextUser = {
        ...user,
        credit: balanceAfter,
        creditHistory: [record, ...user.creditHistory].slice(0, 100),
      };

      if (activeUserName === userName) {
        nextCurrentUser = nextUser;
      }

      return nextUser;
    });

    return { nextUsers, nextCurrentUser };
  };

  const applyCreditChanges = (
    userList: User[],
    changes: Array<{ userName: string; delta: number; reason: string }>,
    activeUserName?: string | null,
  ) => {
    let nextUsers = userList;
    let nextCurrentUser: User | null = null;

    changes.forEach(change => {
      const result = applyCreditDelta(nextUsers, change.userName, change.delta, change.reason, activeUserName);
      nextUsers = result.nextUsers;
      if (result.nextCurrentUser) {
        nextCurrentUser = result.nextCurrentUser;
      }
    });

    return { nextUsers, nextCurrentUser };
  };

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('users', JSON.stringify(users));
  }, [users]);

  useEffect(() => {
    if (currentUser) {
      localStorage.setItem('currentUserName', currentUser.name);
    } else {
      localStorage.removeItem('currentUserName');
    }
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('markets', JSON.stringify(markets));
  }, [markets]);

  useEffect(() => {
    localStorage.setItem('secrets', JSON.stringify(secrets));
  }, [secrets]);

  useEffect(() => {
    localStorage.setItem('feedbacks', JSON.stringify(feedbacks));
  }, [feedbacks]);

  useEffect(() => {
    localStorage.setItem('publicAnnouncement', publicAnnouncement);
  }, [publicAnnouncement]);

  useEffect(() => {
    localStorage.setItem('testInviteCode', testInviteCode);
  }, [testInviteCode]);

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return;

    pullSharedState();
    const timer = window.setInterval(() => {
      pullSharedState();
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return;
    if (!hasCompletedInitialRemoteSync) return;
    if (remoteHydratingRef.current || remoteSavingRef.current) return;

    lastLocalMutationAtRef.current = Date.now();

    const saveSharedState = async () => {
      await persistSharedState();
    };

    void saveSharedState();
  }, [users, markets, secrets, feedbacks, publicAnnouncement, testInviteCode, hasCompletedInitialRemoteSync]);

  useEffect(() => {
    const syncFromHash = () => {
      const match = window.location.hash.match(/^#\/prediction\/(\d+)$/);
      if (match) {
        setMarketDetailId(Number(match[1]));
        setActiveTab('truth');
      } else {
        setMarketDetailId(null);
      }
    };

    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  useEffect(() => {
    if (!currentUser) return;

    const latestUser = users.find(user => user.id === currentUser.id);
    if (!latestUser) {
      setCurrentUser(null);
      return;
    }

    if (!latestUser.isActive) {
      setCurrentUser(null);
      localStorage.removeItem('currentUserName');
      alert('This account has been deactivated by admin.');
      return;
    }

    if (
      latestUser.name !== currentUser.name
      || latestUser.password !== currentUser.password
      || latestUser.credit !== currentUser.credit
      || latestUser.email !== currentUser.email
      || latestUser.isAdmin !== currentUser.isAdmin
    ) {
      setCurrentUser(latestUser);
    }
  }, [users, currentUser]);

  const login = () => {
    const normalizedName = loginName.trim().toLowerCase();
    const normalizedPassword = loginPassword.trim();

    if (!normalizedName || !normalizedPassword) {
      alert('Please enter username and password');
      return;
    }

    const user = users.find(u => u.name.trim().toLowerCase() === normalizedName && u.password === normalizedPassword);
    if (user) {
      if (!user.isActive) {
        alert('This account has been deactivated by admin.');
        return;
      }
      setCurrentUser(user);
      setLoginName('');
      setLoginPassword('');
    } else {
      // Bootstrap an admin account for prototype environments when no admin exists yet.
      if (normalizedName === 'admin' && !users.some(u => u.isAdmin)) {
        const adminUser: User = {
          id: Date.now(),
          name: 'Admin',
          email: '',
          password: normalizedPassword,
          isAdmin: true,
          isActive: true,
          credit: legacyBalance,
          creditHistory: [{
            id: Date.now(),
            delta: legacyBalance,
            reason: 'Initial credit',
            balanceAfter: legacyBalance,
            createdAt: Date.now(),
          }],
        };
        setUsers(prev => [...prev, adminUser]);
        setCurrentUser(adminUser);
        setLoginName('');
        setLoginPassword('');
        alert('Admin account has been created automatically.');
        return;
      }
      alert('Invalid credentials');
    }
  };

  const register = () => {
    const normalizedName = registerName.trim();
    const normalizedEmail = registerEmail.trim().toLowerCase();
    const normalizedPassword = registerPassword.trim();
    const nameKey = normalizedName.toLowerCase();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const hasSameName = users.some(u => u.name.trim().toLowerCase() === nameKey);
    const hasSameEmail = users.some(u => u.email.trim().toLowerCase() === normalizedEmail);

    if (!emailPattern.test(normalizedEmail)) {
      alert('Please enter a valid email address');
      return;
    }

    if (normalizedName && normalizedPassword && !hasSameName && !hasSameEmail) {
      const isAdmin = nameKey === 'admin';
      const user: User = {
        id: Date.now(),
        name: normalizedName,
        email: normalizedEmail,
        password: normalizedPassword,
        isAdmin,
        isActive: true,
        credit: legacyBalance,
        creditHistory: [{
          id: Date.now(),
          delta: legacyBalance,
          reason: 'Initial credit',
          balanceAfter: legacyBalance,
          createdAt: Date.now(),
        }],
      };
      setUsers(prev => [...prev, user]);
      setCurrentUser(user);
      setRegisterName('');
      setRegisterEmail('');
      setRegisterPassword('');
    } else {
      alert('Username/email taken or invalid');
    }
  };

  const handleLoginSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    login();
  };

  const handleRegisterSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    register();
  };

  const logout = () => {
    setCurrentUser(null);
    setActiveTab('truth');
  };

  const updateUserCredit = (userName: string, delta: number, reason: string) => {
    let updatedCurrent: User | null = null;

    setUsers(prev => {
      const result = applyCreditDelta(prev, userName, delta, reason, currentUser?.name);
      updatedCurrent = result.nextCurrentUser;
      return result.nextUsers;
    });

    if (updatedCurrent) {
      setCurrentUser(updatedCurrent);
    }
  };

  const openConfirm = (title: string, message: string, onConfirm: () => void, confirmLabel = 'Confirm') => {
    setPendingAction({ title, message, onConfirm, confirmLabel });
  };

  const classifyCreditReason = (reason: string): 'recharge' | 'publish' | 'vote' | 'secret-income' | 'other' => {
    if (reason.startsWith('Recharge')) return 'recharge';
    if (reason.startsWith('Publish')) return 'publish';
    if (reason.startsWith('Buy') || reason.startsWith('Vote')) return 'vote';
    if (reason.startsWith('Secret income')) return 'secret-income';
    return 'other';
  };

  const toggleUserActive = (targetUser: User) => {
    if (!currentUser?.isAdmin) return;
    if (targetUser.id === currentUser.id && targetUser.isActive) {
      alert('Admin cannot deactivate the current logged-in account.');
      return;
    }

    const nextActive = !targetUser.isActive;
    setUsers(prev => prev.map(user => user.id === targetUser.id ? { ...user, isActive: nextActive } : user));

    if (currentUser.id === targetUser.id) {
      setCurrentUser(prev => prev ? { ...prev, isActive: nextActive } : prev);
    }
  };

  const resetUserPassword = (targetUser: User) => {
    if (!currentUser?.isAdmin) return;
    const nextPassword = (passwordDrafts[targetUser.id] || '').trim();
    if (!nextPassword) {
      alert('Please input a new password first.');
      return;
    }

    setUsers(prev => prev.map(user => user.id === targetUser.id ? { ...user, password: nextPassword } : user));

    if (currentUser.id === targetUser.id) {
      setCurrentUser(prev => prev ? { ...prev, password: nextPassword } : prev);
    }

    setPasswordDrafts(prev => ({ ...prev, [targetUser.id]: '' }));
  };

  const changeOwnPassword = () => {
    if (!currentUser) return;

    const oldPassword = currentPasswordInput.trim();
    const nextPassword = newPasswordInput.trim();
    const confirmPassword = confirmNewPasswordInput.trim();

    if (!oldPassword || !nextPassword || !confirmPassword) {
      alert('请完整填写当前密码、新密码和确认密码。');
      return;
    }

    if (oldPassword !== currentUser.password) {
      alert('当前密码不正确。');
      return;
    }

    if (nextPassword.length < 4) {
      alert('新密码至少需要 4 位。');
      return;
    }

    if (nextPassword !== confirmPassword) {
      alert('两次输入的新密码不一致。');
      return;
    }

    setUsers(prev => prev.map(user => user.id === currentUser.id ? { ...user, password: nextPassword } : user));
    setCurrentUser(prev => prev ? { ...prev, password: nextPassword } : prev);
    setCurrentPasswordInput('');
    setNewPasswordInput('');
    setConfirmNewPasswordInput('');
    alert('密码修改成功。');
  };

  const handleFeedbackImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const imageData = event.target?.result as string;
      setFeedbackImage(imageData);
    };
    reader.readAsDataURL(file);
  };

  const submitFeedback = () => {
    if (!currentUser) {
      alert('Please login first');
      return;
    }

    if (!feedbackContent.trim()) {
      alert('Please enter feedback content');
      return;
    }

    const newFeedback: Feedback = {
      id: Date.now(),
      userName: currentUser.name,
      content: feedbackContent.trim(),
      imageUrl: feedbackImage || undefined,
      createdAt: Date.now(),
      status: 'unread',
    };

    setFeedbacks(prev => [newFeedback, ...prev]);
    setFeedbackContent('');
    setFeedbackImage(null);
    alert('感谢反馈！我们已收到您的建议。');
  };

  const markFeedbackAsRead = (feedbackId: number) => {
    setFeedbacks(prev => prev.map(f => f.id === feedbackId ? { ...f, status: 'read' } : f));
  };

  const deleteFeedback = (feedbackId: number) => {
    setFeedbacks(prev => prev.filter(f => f.id !== feedbackId));
  };

  const saveTestingNotice = () => {
    if (!currentUser?.isAdmin) return;
    setPublicAnnouncement(announcementDraft.trim());
    setTestInviteCode(inviteCodeDraft.trim());
    alert('测试公告已更新。');
  };

  const publishMarket = async () => {
    if (!currentUser || !newQuestion.trim() || !newDeadline) return;

    if (currentUser.credit < PREDICTION_PUBLISH_FEE) {
      alert(`Publishing a prediction requires ${PREDICTION_PUBLISH_FEE} Crypo points.`);
      return;
    }

    const question = newQuestion.trim();
    const createdAt = Date.now();
    const { nextUsers, nextCurrentUser } = applyCreditDelta(
      users,
      currentUser.name,
      -PREDICTION_PUBLISH_FEE,
      `Publish prediction: ${question}`,
      currentUser.name,
    );

    const newMarket: Market = {
      id: createdAt,
      question,
      tag: newTag,
      createdAt,
      participants: [],
      followers: [],
      voteRecords: [],
      resultFeedbacks: [],
      b: 100,
      yesShares: 0,
      noShares: 0,
      yesPrice: 1,
      noPrice: 1,
      creator: currentUser.name,
      deadline: newDeadline,
    };
    const nextMarkets = [newMarket, ...markets];

    setLoadingState({
      type: 'market',
      title: '正在发布预测',
      message: '正在同步预测内容和积分变更，主页更新后会自动关闭。',
    });

    setUsers(nextUsers);
    if (nextCurrentUser) {
      setCurrentUser(nextCurrentUser);
    }
    setMarkets(nextMarkets);
    setNewQuestion('');
    setNewTag('政治');
    setNewDeadline('');

    try {
      const didPersist = await persistSharedState({ users: nextUsers, markets: nextMarkets });
      if (!didPersist) {
        alert(getSyncFailureMessage('预测已发布到当前页面，但同步到主页失败，请稍后刷新确认。'));
      }
    } finally {
      setLoadingState(null);
    }
  };

  const requestPublishMarket = () => {
    if (!currentUser) return;
    if (!newQuestion.trim() || !newDeadline) {
      alert('Please enter prediction question and deadline first.');
      return;
    }

    const projected = currentUser.credit - PREDICTION_PUBLISH_FEE;
    openConfirm(
      '确认发布预测',
      `发布该预测将消耗 ${PREDICTION_PUBLISH_FEE} Crypo points。\n预计剩余：${projected.toFixed(2)} Crypo points。`,
      publishMarket,
      `发布并扣除 ${PREDICTION_PUBLISH_FEE}`,
    );
  };

  const deleteMarket = (id: number) => {
    if (confirm('Delete this market?')) {
      setMarkets(prev => prev.filter(m => m.id !== id));
    }
  };

  const startEdit = (market: Market) => {
    setEditingMarket(market);
    setEditQuestion(market.question);
    setEditDeadline(market.deadline);
  };

  const saveEdit = () => {
    if (editingMarket) {
      setMarkets(prev => prev.map(m => m.id === editingMarket.id ? { ...m, question: editQuestion, deadline: editDeadline } : m));
      setEditingMarket(null);
      setEditQuestion('');
      setEditDeadline('');
    }
  };

  const cancelEdit = () => {
    setEditingMarket(null);
    setEditQuestion('');
    setEditDeadline('');
  };

  const recharge = () => {
    const amount = parseFloat(rechargeAmount);
    if (amount > 0) {
      alert(`Simulating PayPal payment of ${amount} Crypo points. Payment successful!`);
      if (currentUser) {
        updateUserCredit(currentUser.name, amount, 'Recharge via PayPal');
      }
      setRechargeAmount('');
      setShowRecharge(false);
    } else {
      alert('Invalid amount');
    }
  };

  const handleSecretImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setNewSecretImage(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setNewSecretImage(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleEditSecretImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setEditSecretImage(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const shareSecret = async () => {
    if (!currentUser || !newTitle.trim() || !newSecret.trim()) return;

    if (currentUser.credit < SECRET_PUBLISH_FEE) {
      alert(`Publishing a secret requires ${SECRET_PUBLISH_FEE} Crypo points.`);
      return;
    }

    const title = newTitle.trim();
    const content = newSecret.trim();
    const createdAt = Date.now();
    const { nextUsers, nextCurrentUser } = applyCreditDelta(
      users,
      currentUser.name,
      -SECRET_PUBLISH_FEE,
      `Publish secret: ${title}`,
      currentUser.name,
    );

    const secret: Secret = {
      id: createdAt,
      title,
      content,
      author: currentUser.name,
      price: newSecretPrice,
      imageUrl: newSecretImage ?? undefined,
      createdAt,
      ratings: [],
    };
    const nextSecrets = [secret, ...secrets];

    setLoadingState({
      type: 'secret',
      title: '正在发布秘密',
      message: '正在同步秘密内容和积分变更，列表更新后会自动关闭。',
    });

    setUsers(nextUsers);
    if (nextCurrentUser) {
      setCurrentUser(nextCurrentUser);
    }
    setSecrets(nextSecrets);
    setNewTitle('');
    setNewSecret('');
    setNewSecretImage(null);
    setNewSecretPrice(1);

    try {
      const didPersist = await persistSharedState({ users: nextUsers, secrets: nextSecrets });
      if (!didPersist) {
        alert(getSyncFailureMessage('秘密已发布到当前页面，但同步到主页失败，请稍后刷新确认。'));
      }
    } finally {
      setLoadingState(null);
    }
  };

  const requestShareSecret = () => {
    if (!currentUser) return;
    if (!newTitle.trim() || !newSecret.trim()) {
      alert('Please enter secret title and content first.');
      return;
    }

    const projected = currentUser.credit - SECRET_PUBLISH_FEE;
    openConfirm(
      '确认发布秘密',
      `发布该秘密将消耗 ${SECRET_PUBLISH_FEE} Crypo points。\n预计剩余：${projected.toFixed(2)} Crypo points。`,
      shareSecret,
      `发布并扣除 ${SECRET_PUBLISH_FEE}`,
    );
  };

  const startEditSecret = (secret: Secret) => {
    setEditingSecret(secret);
    setEditSecretTitle(secret.title);
    setEditSecretContent(secret.content);
    setEditSecretImage(secret.imageUrl ?? null);
    setEditSecretPrice(secret.price);
  };

  const saveSecretEdit = () => {
    if (editingSecret) {
      setSecrets(prev => prev.map(s => s.id === editingSecret.id ? { ...s, title: editSecretTitle, content: editSecretContent, imageUrl: editSecretImage ?? undefined, price: editSecretPrice } : s));
      setEditingSecret(null);
      setEditSecretTitle('');
      setEditSecretContent('');
      setEditSecretImage(null);
      setEditSecretPrice(1);
    }
  };

  const cancelSecretEdit = () => {
    setEditingSecret(null);
    setEditSecretTitle('');
    setEditSecretContent('');
    setEditSecretImage(null);
    setEditSecretPrice(1);
  };

  const deleteSecret = (secretId: number) => {
    if (confirm('Delete this secret?')) {
      setSecrets(prev => prev.filter(s => s.id !== secretId));
      setViewedSecrets(prev => {
        const next = new Set(prev);
        next.delete(secretId);
        return next;
      });
    }
  };

  const viewSecret = async (secretId: number) => {
    const secret = secrets.find(s => s.id === secretId);
    if (!secret) return;
    if (!currentUser) return;

    if (currentUser.name === secret.author) {
      // Authors can view their own secrets for free
      setViewedSecrets(prev => new Set(prev).add(secretId));
      return;
    }

    if (currentUser.credit >= secret.price) {
      const { nextUsers, nextCurrentUser } = applyCreditChanges(
        users,
        [
          { userName: currentUser.name, delta: -secret.price, reason: `View secret: ${secret.title}` },
          { userName: secret.author, delta: secret.price, reason: `Secret income: ${secret.title}` },
        ],
        currentUser.name,
      );

      setLoadingState({
        type: 'secret-view',
        title: '正在解锁秘密',
        message: '正在同步积分扣费和秘密权限，内容准备完成后会自动展示。',
      });

      setUsers(nextUsers);
      if (nextCurrentUser) {
        setCurrentUser(nextCurrentUser);
      }
      setViewedSecrets(prev => new Set(prev).add(secretId));

      try {
        const didPersist = await persistSharedState({ users: nextUsers });
        if (!didPersist) {
          alert(getSyncFailureMessage('秘密已在当前页面解锁，但积分同步失败，请稍后刷新确认。'));
        }
      } finally {
        setLoadingState(null);
      }
    } else {
      alert('Insufficient Crypo points');
    }
  };

  const requestViewSecret = (secret: Secret) => {
    if (!currentUser) return;
    if (currentUser.name === secret.author) {
      viewSecret(secret.id);
      return;
    }

    const projected = currentUser.credit - secret.price;
    openConfirm(
      '确认查看秘密',
      `查看该秘密将支付 ${secret.price} Crypo points 给发布者 ${secret.author}。\n预计剩余：${projected.toFixed(2)} Crypo points。`,
      () => viewSecret(secret.id),
      `支付 ${secret.price} 并查看`,
    );
  };

  const rateSecret = (secretId: number, authenticity: '真实' | '不真实', value: '值得' | '不值得') => {
    if (!currentUser) return;

    const awardPoints = (author: string, points: number) => {
      updateUserCredit(author, points, 'Secret rating reward');
    };

    setSecrets(prev => prev.map(s => {
      if (s.id === secretId) {
        const existing = s.ratings.find(r => r.user === currentUser.name);
        const newRating = { user: currentUser.name, authenticity, value };
        const newRatings = existing ? s.ratings.map(r => r.user === currentUser.name ? newRating : r) : [...s.ratings, newRating];
        // Only award point delta to prevent repeated toggling from farming points.
        const oldScore = scoreFromRating(existing);
        const newScore = scoreFromRating(newRating);
        const delta = newScore - oldScore;
        if (delta !== 0) {
          awardPoints(s.author, delta);
        }
        return { ...s, ratings: newRatings };
      }
      return s;
    }));
  };

  const buyShare = async (marketId: number, outcome: 'yes' | 'no', voteAmount: number) => {
    if (!currentUser) return;

    if (currentUser.credit < voteAmount) {
      alert('Insufficient Crypo points');
      return;
    }

    const voteTimestamp = Date.now();
    let didVote = false;
    const nextMarkets = markets.map(market => {
      if (market.id !== marketId) return market;

      if (market.resolvedOutcome) {
        alert('该预测已结算，无法继续投票。');
        return market;
      }

      if (new Date(market.deadline).getTime() <= Date.now()) {
        alert('该预测已截止，无法继续投票。');
        return market;
      }

      const hasActiveVote = market.voteRecords.some(record => record.user === currentUser.name && record.status === 'active');
      if (hasActiveVote) {
        alert('你在该预测已投过，不能重复投票。');
        return market;
      }

      const nextMarket = { ...market };
      if (outcome === 'yes') {
        nextMarket.yesShares += voteAmount;
      } else {
        nextMarket.noShares += voteAmount;
      }
      if (!nextMarket.participants.includes(currentUser.name)) {
        nextMarket.participants = [...nextMarket.participants, currentUser.name];
      }
      nextMarket.voteRecords = [
        ...nextMarket.voteRecords,
        { id: voteTimestamp + Math.floor(Math.random() * 1000), user: currentUser.name, outcome, amount: voteAmount, createdAt: voteTimestamp, status: 'active' },
      ];
      didVote = true;
      return nextMarket;
    });

    if (!didVote) {
      return;
    }

    const { nextUsers, nextCurrentUser } = applyCreditChanges(
      users,
      [{ userName: currentUser.name, delta: -voteAmount, reason: `Vote ${outcome.toUpperCase()} on prediction (${voteAmount} Crypo points)` }],
      currentUser.name,
    );

    setLoadingState({
      type: 'vote',
      title: '正在提交投票',
      message: '正在同步投票结果和积分扣费，预测主页更新后会自动关闭。',
    });

    setUsers(nextUsers);
    if (nextCurrentUser) {
      setCurrentUser(nextCurrentUser);
    }
    setMarkets(nextMarkets);

    try {
      const didPersist = await persistSharedState({ users: nextUsers, markets: nextMarkets });
      if (!didPersist) {
        alert(getSyncFailureMessage('投票已在当前页面生效，但主页同步失败，请稍后刷新确认。'));
      }
    } finally {
      setLoadingState(null);
    }
  };

  const requestBuyShare = (market: Market, outcome: 'yes' | 'no') => {
    if (!currentUser) return;

    if (market.resolvedOutcome) {
      alert('该预测已结算，无法继续投票。');
      return;
    }

    if (new Date(market.deadline).getTime() <= Date.now()) {
      alert('该预测已截止，无法继续投票。');
      return;
    }

    const hasActiveVote = market.voteRecords.some(record => record.user === currentUser.name && record.status === 'active');
    if (hasActiveVote) {
      const activeVote = market.voteRecords
        .filter(record => record.user === currentUser.name && record.status === 'active')
        .sort((a, b) => b.createdAt - a.createdAt)[0];

      setPendingVoteChoice({
        marketId: market.id,
        outcome,
        mode: 'edit',
        previousAmount: activeVote?.amount ?? 0,
      });
      return;
    }

    setPendingVoteChoice({ marketId: market.id, outcome, mode: 'new' });
  };

  const submitVoteWithAmount = (amount: number) => {
    if (!pendingVoteChoice || !currentUser) return;

    const { marketId, outcome, mode } = pendingVoteChoice;
    setPendingVoteChoice(null);

    if (mode === 'edit') {
      void modifyVoteChoice(marketId, outcome, amount);
      return;
    }

    if (currentUser.credit < amount) {
      alert('Insufficient Crypo points');
      return;
    }

    void buyShare(marketId, outcome, amount);
  };

  const modifyVoteChoice = async (marketId: number, outcome: 'yes' | 'no', nextAmount: number) => {
    if (!currentUser) return;

    const market = markets.find(item => item.id === marketId);
    if (!market) return;

    if (market.resolvedOutcome || new Date(market.deadline).getTime() <= Date.now()) {
      alert('该预测当前不可修改投票。');
      return;
    }

    const currentVote = market.voteRecords
      .filter(record => record.user === currentUser.name && record.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (!currentVote) {
      void buyShare(marketId, outcome, nextAmount);
      return;
    }

    const creditAfterRefund = currentUser.credit + currentVote.amount;
    if (creditAfterRefund < nextAmount) {
      alert('Insufficient Crypo points');
      return;
    }

    const changeTimestamp = Date.now();
    const nextMarkets = markets.map(item => {
      if (item.id !== marketId) return item;

      const targetIndex = item.voteRecords.findIndex(record => record.id === currentVote.id);
      if (targetIndex < 0) return item;

      const revokedRecords = item.voteRecords.map((record, index) => {
        if (index !== targetIndex) return record;
        return { ...record, status: 'revoked' as const, revokedAt: changeTimestamp };
      });

      const newRecord: Market['voteRecords'][number] = {
        id: changeTimestamp + Math.floor(Math.random() * 1000),
        user: currentUser.name,
        outcome,
        amount: nextAmount,
        createdAt: changeTimestamp,
        status: 'active',
      };

      const nextMarket = {
        ...item,
        voteRecords: [...revokedRecords, newRecord],
        yesShares: item.yesShares,
        noShares: item.noShares,
      };

      if (currentVote.outcome === 'yes') {
        nextMarket.yesShares = Math.max(0, nextMarket.yesShares - currentVote.amount);
      } else {
        nextMarket.noShares = Math.max(0, nextMarket.noShares - currentVote.amount);
      }

      if (outcome === 'yes') {
        nextMarket.yesShares += nextAmount;
      } else {
        nextMarket.noShares += nextAmount;
      }

      return nextMarket;
    });

    const { nextUsers, nextCurrentUser } = applyCreditChanges(
      users,
      [{
        userName: currentUser.name,
        delta: currentVote.amount - nextAmount,
        reason: `Modify vote on prediction (${currentVote.amount} -> ${nextAmount} Crypo points)`
      }],
      currentUser.name,
    );

    setLoadingState({
      type: 'vote',
      title: '正在修改投票',
      message: '正在退回原投入并提交新选择，预测主页更新后会自动关闭。',
    });

    setUsers(nextUsers);
    if (nextCurrentUser) {
      setCurrentUser(nextCurrentUser);
    }
    setMarkets(nextMarkets);

    try {
      const didPersist = await persistSharedState({ users: nextUsers, markets: nextMarkets });
      if (!didPersist) {
        alert(getSyncFailureMessage('投票修改已在当前页面生效，但主页同步失败，请稍后刷新确认。'));
      }
    } finally {
      setLoadingState(null);
    }
  };

  const calculateSettlementRewards = (market: Market, outcome: 'yes' | 'no') => {
    const activeVotes = market.voteRecords.filter(record => record.status === 'active');
    const correctVotes = activeVotes.filter(record => record.outcome === outcome);
    const totalStake = activeVotes.reduce((sum, record) => sum + record.amount, 0);
    const correctStake = correctVotes.reduce((sum, record) => sum + record.amount, 0);
    const rewardPerStake = correctStake > 0 ? totalStake / correctStake : 0;

    const userRewards = correctVotes.reduce<Record<string, number>>((acc, record) => {
      acc[record.user] = (acc[record.user] ?? 0) + (record.amount * rewardPerStake);
      return acc;
    }, {});

    return { activeVotes, correctVotes, rewardPerStake, userRewards };
  };

  const settleMarket = async (marketId: number, outcome: 'yes' | 'no') => {
    if (!currentUser) return;

    const market = markets.find(item => item.id === marketId);
    if (!market) return;
    if (new Date(market.deadline).getTime() > Date.now()) return;
    if (!market.resolvedOutcome && !(currentUser.isAdmin || currentUser.name === market.creator)) return;
    if (market.resolvedOutcome && !currentUser.isAdmin) return;

    const previousRewards = market.resolvedOutcome
      ? calculateSettlementRewards(market, market.resolvedOutcome).userRewards
      : {};
    const nextRewards = calculateSettlementRewards(market, outcome).userRewards;
    const allUsers = new Set([...Object.keys(previousRewards), ...Object.keys(nextRewards)]);

    const creditChanges = [...allUsers]
      .map(userName => ({
        userName,
        delta: (nextRewards[userName] ?? 0) - (previousRewards[userName] ?? 0),
        reason: market.resolvedOutcome ? `Prediction result adjustment: ${market.question}` : `Prediction reward: ${market.question}`,
      }))
      .filter(change => change.delta !== 0);

    const { nextUsers, nextCurrentUser } = applyCreditChanges(users, creditChanges, currentUser.name);
    const nextMarkets = markets.map(item => item.id === marketId ? {
      ...item,
      resolvedOutcome: outcome,
      resolvedAt: Date.now(),
    } : item);

    setLoadingState({
      type: 'settlement',
      title: market.resolvedOutcome ? '正在修改最终结果' : '正在发布最终结果',
      message: '正在同步结算结果和奖励分配，预测主页更新后会自动关闭。',
    });

    setUsers(nextUsers);
    if (nextCurrentUser) {
      setCurrentUser(nextCurrentUser);
    }
    setMarkets(nextMarkets);

    try {
      const didPersist = await persistSharedState({ users: nextUsers, markets: nextMarkets });
      if (!didPersist) {
        alert(getSyncFailureMessage('最终结果已在当前页面生效，但主页同步失败，请稍后刷新确认。'));
      }
    } finally {
      setLoadingState(null);
    }
  };

  const requestSettleMarket = (market: Market, outcome: 'yes' | 'no') => {
    if (!currentUser) return;
    if (new Date(market.deadline).getTime() > Date.now()) {
      alert('预测尚未截止，暂时不能发布结果。');
      return;
    }
    if (!market.resolvedOutcome && !(currentUser.isAdmin || currentUser.name === market.creator)) {
      alert('仅发布者或管理员可以发布预测结果。');
      return;
    }
    if (market.resolvedOutcome && !currentUser.isAdmin) {
      alert('仅管理员可以修改已经发布的最终结果。');
      return;
    }

    const settlementPreview = calculateSettlementRewards(market, outcome);

    openConfirm(
      `${market.resolvedOutcome ? '确认修改最终结果' : '确认最终结果'}：${outcome === 'yes' ? '会的' : '不会的'}`,
      `${market.resolvedOutcome ? '确认后将按新结果重新结算该预测。' : '确认后将结算该预测。'}\n有效投票数：${settlementPreview.activeVotes.length}。\n命中票数：${settlementPreview.correctVotes.length}。\n每 1 Crypo point 正确投入预计返还 ${settlementPreview.rewardPerStake.toFixed(2)} Crypo points。${market.resolvedOutcome ? `\n当前结果：${market.resolvedOutcome === 'yes' ? '会的' : '不会的'}，系统会自动按差额调整奖励。` : ''}`,
      () => settleMarket(market.id, outcome),
      market.resolvedOutcome ? '确认修改结果' : '确认结算',
    );
  };

  const submitResultFeedback = (marketId: number, stance: 'accept' | 'verify') => {
    if (!currentUser) return;

    setMarkets(prev => prev.map(market => {
      if (market.id !== marketId) return market;
      if (new Date(market.deadline).getTime() > Date.now()) return market;
      if (!market.participants.includes(currentUser.name)) return market;

      const nextFeedback = {
        user: currentUser.name,
        stance,
        createdAt: Date.now(),
      };

      const existed = market.resultFeedbacks.some(item => item.user === currentUser.name);
      const nextFeedbacks = existed
        ? market.resultFeedbacks.map(item => item.user === currentUser.name ? nextFeedback : item)
        : [...market.resultFeedbacks, nextFeedback];

      return {
        ...market,
        resultFeedbacks: nextFeedbacks,
      };
    }));
  };

  const toggleFollowMarket = (marketId: number) => {
    if (!currentUser) return;

    setMarkets(prev => prev.map(market => {
      if (market.id !== marketId) return market;
      const alreadyFollowed = market.followers.includes(currentUser.name);
      const nextFollowers = alreadyFollowed
        ? market.followers.filter(name => name !== currentUser.name)
        : [...market.followers, currentUser.name];
      return { ...market, followers: nextFollowers };
    }));
  };

  const togglePinMarket = (marketId: number) => {
    if (!currentUser) return;

    setMarkets(prev => prev.map(market => {
      if (market.id !== marketId) return market;
      return {
        ...market,
        pinnedAt: typeof market.pinnedAt === 'number' ? undefined : Date.now(),
      };
    }));
  };

  const openMarketDetail = (marketId: number) => {
    window.location.hash = `#/prediction/${marketId}`;
  };

  const closeMarketDetail = () => {
    window.location.hash = '#/predictions';
  };

  const now = Date.now();
  const filteredSecrets = secrets
    .filter(secret => {
      if (secretTimeFilter === 'today') {
        return now - secret.createdAt <= 24 * 60 * 60 * 1000;
      }
      if (secretTimeFilter === 'week') {
        return now - secret.createdAt <= 7 * 24 * 60 * 60 * 1000;
      }
      return true;
    })
    .sort((left, right) => {
      if (secretSort === 'latest') {
        return right.createdAt - left.createdAt;
      }
      if (secretSort === 'oldest') {
        return left.createdAt - right.createdAt;
      }
      if (secretSort === 'price-high') {
        return right.price - left.price;
      }
      return left.price - right.price;
    });

  const filteredMarkets = markets
    .filter(market => {
      const keyword = marketKeyword.trim().toLowerCase();
      const hitKeyword = !keyword
        || market.question.toLowerCase().includes(keyword)
        || market.creator.toLowerCase().includes(keyword)
        || market.tag.includes(keyword)
        || market.deadline.includes(keyword);

      const hitTag = marketTagFilter === 'all' || market.tag === marketTagFilter;

      const marketDeadlineAt = new Date(market.deadline).getTime();
      const nowAt = Date.now();
      const sevenDaysLater = nowAt + 7 * 24 * 60 * 60 * 1000;

      const hitDeadline =
        marketDeadlineFilter === 'all'
        || (marketDeadlineFilter === 'upcoming' && marketDeadlineAt >= nowAt)
        || (marketDeadlineFilter === 'soon' && marketDeadlineAt >= nowAt && marketDeadlineAt <= sevenDaysLater)
        || (marketDeadlineFilter === 'expired' && marketDeadlineAt < nowAt);

      const hitDeadlineDate = !marketDeadlineDate || market.deadline === marketDeadlineDate;

      const hitScope =
        marketScopeFilter === 'all'
        || (marketScopeFilter === 'mine' && market.creator === currentUser?.name)
        || (marketScopeFilter === 'participated' && Boolean(currentUser && market.participants.includes(currentUser.name)))
        || (marketScopeFilter === 'followed' && Boolean(currentUser && market.followers.includes(currentUser.name)));

      return hitKeyword && hitTag && hitDeadline && hitDeadlineDate && hitScope;
    })
    .sort((left, right) => {
      const leftPinned = typeof left.pinnedAt === 'number';
      const rightPinned = typeof right.pinnedAt === 'number';
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (leftPinned && rightPinned) {
        return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0);
      }
      return right.createdAt - left.createdAt;
    });

  const resetMarketFilters = () => {
    setMarketKeyword('');
    setMarketTagFilter('all');
    setMarketDeadlineFilter('all');
    setMarketDeadlineDate('');
    setMarketScopeFilter('all');
  };

  const formatSecretTime = (createdAt: number) => new Date(createdAt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const formatCreditTime = (createdAt: number) => new Date(createdAt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const filteredCreditHistory = currentUser
    ? currentUser.creditHistory.filter(record => creditHistoryFilter === 'all' || classifyCreditReason(record.reason) === creditHistoryFilter)
    : [];

  const selectedMarket = marketDetailId ? markets.find(market => market.id === marketDetailId) ?? null : null;

  const detailVoteStats = selectedMarket
    ? Object.values(selectedMarket.voteRecords.reduce<Record<string, { user: string; yes: number; no: number; total: number; revoked: number; lastVoteAt: number }>>((acc, vote) => {
      const existing = acc[vote.user] ?? { user: vote.user, yes: 0, no: 0, total: 0, revoked: 0, lastVoteAt: 0 };
      const next = {
        ...existing,
        yes: existing.yes + (vote.status === 'active' && vote.outcome === 'yes' ? 1 : 0),
        no: existing.no + (vote.status === 'active' && vote.outcome === 'no' ? 1 : 0),
        total: existing.total + 1,
        revoked: existing.revoked + (vote.status === 'revoked' ? 1 : 0),
        lastVoteAt: Math.max(existing.lastVoteAt, vote.createdAt),
      };
      acc[vote.user] = next;
      return acc;
    }, {})).sort((a, b) => b.total - a.total)
    : [];

  const detailProfitLeaderboard = selectedMarket && selectedMarket.resolvedOutcome
    ? (() => {
      const activeVotes = selectedMarket.voteRecords.filter(record => record.status === 'active');
      const correctVotes = activeVotes.filter(record => record.outcome === selectedMarket.resolvedOutcome);
      const totalStake = activeVotes.reduce((sum, record) => sum + record.amount, 0);
      const correctStake = correctVotes.reduce((sum, record) => sum + record.amount, 0);
      const rewardPerStake = correctStake > 0 ? totalStake / correctStake : 0;

      return Object.values(activeVotes.reduce<Record<string, { user: string; spent: number; reward: number; profit: number; correctVotes: number; wrongVotes: number }>>((acc, vote) => {
        const existing = acc[vote.user] ?? { user: vote.user, spent: 0, reward: 0, profit: 0, correctVotes: 0, wrongVotes: 0 };
        const isCorrect = vote.outcome === selectedMarket.resolvedOutcome;
        const stake = vote.amount;
        const reward = isCorrect ? stake * rewardPerStake : 0;
        const next = {
          ...existing,
          spent: existing.spent + stake,
          reward: existing.reward + reward,
          profit: existing.profit + reward - stake,
          correctVotes: existing.correctVotes + (isCorrect ? 1 : 0),
          wrongVotes: existing.wrongVotes + (isCorrect ? 0 : 1),
        };
        acc[vote.user] = next;
        return acc;
      }, {})).sort((a, b) => b.profit - a.profit);
    })()
    : [];

  const formatVoteTime = (createdAt: number) => new Date(createdAt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const renderAdminUserManagement = () => (
    <div className="admin-user-panel">
      <h3>用户管理</h3>
      <p className="hint">查看注册用户列表，并管理激活状态和密码设置。</p>
      <div className="admin-user-list">
        {users.map(user => (
          <div key={user.id} className="admin-user-row">
            <div className="admin-user-info">
              <strong>{user.name}</strong>
              <span>{user.email || '未绑定邮箱'} | {user.isAdmin ? '管理员' : '普通用户'} | {user.isActive ? '已激活' : '已停用'} | Credit: {user.credit.toFixed(2)}</span>
            </div>
            <div className="admin-user-actions">
              <button onClick={() => toggleUserActive(user)}>{user.isActive ? '停用账号' : '激活账号'}</button>
              <input
                type="password"
                placeholder="设置新密码"
                value={passwordDrafts[user.id] || ''}
                onChange={(e) => setPasswordDrafts(prev => ({ ...prev, [user.id]: e.target.value }))}
              />
              <button onClick={() => resetUserPassword(user)}>重设密码</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderSelfPasswordPanel = () => (
    <div className="self-password-panel">
      <h3>修改我的密码</h3>
      <p className="hint">普通用户和管理员都可以在这里自行修改登录密码。</p>
      <div className="self-password-form">
        <input
          type="password"
          placeholder="当前密码"
          value={currentPasswordInput}
          onChange={(e) => setCurrentPasswordInput(e.target.value)}
        />
        <input
          type="password"
          placeholder="新密码（至少 4 位）"
          value={newPasswordInput}
          onChange={(e) => setNewPasswordInput(e.target.value)}
        />
        <input
          type="password"
          placeholder="确认新密码"
          value={confirmNewPasswordInput}
          onChange={(e) => setConfirmNewPasswordInput(e.target.value)}
        />
        <button onClick={changeOwnPassword}>保存新密码</button>
      </div>
    </div>
  );

  const renderFeedbackManagement = () => {
    const unreadCount = feedbacks.filter(f => f.status === 'unread').length;
    return (
      <div className="feedback-management-panel">
        <h3>意见反馈管理</h3>
        <p className="hint">未读反馈: <strong>{unreadCount}</strong> 条 | 总计: <strong>{feedbacks.length}</strong> 条</p>
        {feedbacks.length === 0 ? (
          <p className="empty-hint">暂无反馈</p>
        ) : (
          <div className="feedback-list">
            {feedbacks.map(feedback => (
              <div key={feedback.id} className={`feedback-item ${feedback.status === 'unread' ? 'unread' : 'read'}`}>
                <div className="feedback-header">
                  <span className="feedback-user">{feedback.userName}</span>
                  <span className="feedback-time">{new Date(feedback.createdAt).toLocaleString('zh-CN')}</span>
                  <span className={`feedback-status ${feedback.status}`}>{feedback.status === 'unread' ? '未读' : '已读'}</span>
                </div>
                <div className="feedback-content">{feedback.content}</div>
                {feedback.imageUrl && (
                  <div className="feedback-image">
                    <img src={feedback.imageUrl} alt="feedback" />
                  </div>
                )}
                <div className="feedback-actions">
                  {feedback.status === 'unread' && (
                    <button onClick={() => markFeedbackAsRead(feedback.id)} className="mark-read-btn">标记为已读</button>
                  )}
                  <button onClick={() => deleteFeedback(feedback.id)} className="delete-btn">删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderTestingNoticePanel = () => (
    <div className="testing-notice-panel">
      <h3>测试邀请码与公告</h3>
      <p className="hint">管理员可在这里维护给测试用户看的公告和邀请码。</p>
      <div className="testing-notice-form">
        <textarea
          value={announcementDraft}
          onChange={(e) => setAnnouncementDraft(e.target.value)}
          rows={4}
          placeholder="输入测试公告"
        />
        <input
          type="text"
          value={inviteCodeDraft}
          onChange={(e) => setInviteCodeDraft(e.target.value)}
          placeholder="输入测试邀请码（可选）"
        />
        <button onClick={saveTestingNotice}>保存公告</button>
      </div>
    </div>
  );

  const renderPublicTestingNotice = () => {
    if (!publicAnnouncement.trim() && !testInviteCode.trim()) return null;
    return (
      <div className="public-testing-notice">
        <h3>测试公告</h3>
        {publicAnnouncement.trim() && <p>{publicAnnouncement}</p>}
        {testInviteCode.trim() && (
          <div className="invite-code-row">
            <span>测试邀请码</span>
            <strong>{testInviteCode}</strong>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`app${activeTab === 'secret' ? ' secret-mode' : ''}`}>
      {loadingState && (
        <div className="loading-overlay" role="status" aria-live="polite" aria-busy="true">
          <div className="loading-modal">
            <div className="loading-spinner" />
            <h3>{loadingState.title}</h3>
            <p>{loadingState.message}</p>
          </div>
        </div>
      )}
      <div className="home-logo-wrap">
        <img
          className="home-logo"
          src={HOME_LOGO_URL}
          alt="社交对线平台 Logo"
        />
      </div>
      {!currentUser ? (
        <div className="auth">
          <h2>{isLogin ? 'Login' : 'Register'}</h2>
          {isLogin ? (
            <form className="auth-form" onSubmit={handleLoginSubmit}>
              <input
                type="text"
                placeholder="Username"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
              />
              <div className="auth-actions">
                <button className="auth-primary-btn" type="submit">Login</button>
              </div>
            </form>
          ) : (
            <form className="auth-form" onSubmit={handleRegisterSubmit}>
              <input
                type="text"
                placeholder="Username"
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
              />
              <input
                type="email"
                placeholder="Email"
                value={registerEmail}
                onChange={(e) => setRegisterEmail(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={registerPassword}
                onChange={(e) => setRegisterPassword(e.target.value)}
              />
              <div className="auth-actions">
                <button className="auth-primary-btn" type="submit">Register</button>
              </div>
            </form>
          )}
          <div className="auth-switch-row">
            <button className="auth-switch-btn" onClick={() => setIsLogin(!isLogin)}>
              {isLogin ? 'Need to register?' : 'Already have account?'}
            </button>
          </div>
          <div className="auth-notice">
            <h3>用户须知：社交规范与免责声明</h3>
            <p><strong>社交规范</strong></p>
            <ul>
              <li>请以尊重、理性、友善的方式交流，不攻击他人，不煽动对立。</li>
              <li>发布预测和评论时应尽量基于事实与公开信息，不故意制造误导。</li>
              <li>禁止骚扰、辱骂、歧视、人身威胁及恶意刷屏等破坏社区秩序的行为。</li>
              <li>请保护他人隐私，不公开他人敏感信息，不冒充他人身份。</li>
              <li>如发现争议内容，请优先使用“我要验牌”等机制反馈，避免情绪化冲突。</li>
            </ul>
            <p><strong>免责声明</strong></p>
            <ul>
              <li>本工具为原型与社交互动用途，不构成投资建议、法律建议或任何专业意见。</li>
              <li>预测结果与用户观点仅代表个人立场，平台不保证其准确性、完整性或时效性。</li>
              <li>积分（Crypo points）仅用于站内体验，不具备现实货币价值，不可兑现或转售。</li>
              <li>用户应自行判断并承担使用风险；因个人决策导致的损失由用户自行承担。</li>
              <li>平台可根据治理需要对违规内容、违规账号采取限制、下架或停用措施。</li>
            </ul>
          </div>
        </div>
      ) : (
        <>
          <div className="header">
            <div className="welcome">
              <span>Welcome, </span>
              <button className="welcome-user-link" onClick={() => setActiveTab('account')}>{currentUser.name}</button>
              <span>! </span>
              {currentUser.isAdmin && '(Admin)'}
            </div>
            <div className="balance-section">
              <button className="credit-link" onClick={() => setActiveTab('credit')}>
                Credit: {currentUser.credit.toFixed(2)} Crypo points
              </button>
              <button className="recharge-btn" onClick={() => setShowRecharge(true)}>Recharge</button>
              <button className="logout-btn" onClick={logout}>Logout</button>
            </div>
          </div>
          <div className="tabs">
            <button className={activeTab === 'truth' ? 'active' : ''} onClick={() => setActiveTab('truth')}>我有一个预测</button>
            <button className={activeTab === 'secret' ? 'active' : ''} onClick={() => setActiveTab('secret')}>我有一个小秘密</button>
            <button className={activeTab === 'feedback' ? 'active' : ''} onClick={() => setActiveTab('feedback')}>意见反馈</button>
            {currentUser.isAdmin && (
              <button className={activeTab === 'admin' ? 'active' : ''} onClick={() => setActiveTab('admin')}>管理员</button>
            )}
          </div>
          {renderPublicTestingNotice()}
          {showRecharge && (
            <div className="recharge-modal">
              <h3>Recharge Crypo points</h3>
              <input
                type="number"
                placeholder="Crypo points amount"
                value={rechargeAmount}
                onChange={(e) => setRechargeAmount(e.target.value)}
              />
              <button onClick={recharge}>Pay with PayPal</button>
              <button onClick={() => setShowRecharge(false)}>Cancel</button>
            </div>
          )}
          {pendingAction && (
            <div className="confirm-overlay" onClick={() => setPendingAction(null)}>
              <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
                <h3>{pendingAction.title}</h3>
                <p>{pendingAction.message}</p>
                <div className="confirm-actions">
                  <button className="confirm-cancel" onClick={() => setPendingAction(null)}>取消</button>
                  <button
                    onClick={() => {
                      pendingAction.onConfirm();
                      setPendingAction(null);
                    }}
                  >
                    {pendingAction.confirmLabel}
                  </button>
                </div>
              </div>
            </div>
          )}
          {pendingVoteChoice && (
            <div className="confirm-overlay" onClick={() => setPendingVoteChoice(null)}>
              <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
                <h3>{pendingVoteChoice.mode === 'edit' ? '修改我的选择' : '选择投票额度'}</h3>
                <p>
                  你选择了“{pendingVoteChoice.outcome === 'yes' ? '会的' : '不会的'}”，请选择本次投入。
                  {pendingVoteChoice.mode === 'edit' && ` 将先退回你当前的 ${pendingVoteChoice.previousAmount ?? 0} Crypo points。`}
                </p>
                <div className="confirm-actions">
                  <button className="confirm-cancel" onClick={() => setPendingVoteChoice(null)}>取消</button>
                  <button onClick={() => submitVoteWithAmount(VOTE_AMOUNT_OPTIONS[0])}>小试牛刀 {VOTE_AMOUNT_OPTIONS[0]} Crypo point</button>
                  <button onClick={() => submitVoteWithAmount(VOTE_AMOUNT_OPTIONS[1])}>强力跟注 {VOTE_AMOUNT_OPTIONS[1]} Crypo points</button>
                  <button onClick={() => submitVoteWithAmount(VOTE_AMOUNT_OPTIONS[2])}>全力 All in {VOTE_AMOUNT_OPTIONS[2]} Crypo points</button>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'credit' && (
            <div className="publish">
              <h2>Credit History</h2>
              <p className="hint">这里记录你的 Crypo points 每一笔变化。</p>
              <div className="credit-filter-row">
                <label>
                  类型筛选
                  <select value={creditHistoryFilter} onChange={(e) => setCreditHistoryFilter(e.target.value as 'all' | 'recharge' | 'publish' | 'vote' | 'secret-income' | 'other')}>
                    <option value="all">全部</option>
                    <option value="recharge">充值</option>
                    <option value="publish">发布</option>
                    <option value="vote">预测投票</option>
                    <option value="secret-income">秘密收入</option>
                    <option value="other">其他</option>
                  </select>
                </label>
              </div>
              {filteredCreditHistory.length === 0 ? (
                <div className="secret-empty">暂无 Credit 变化记录。</div>
              ) : (
                <div className="credit-history-list">
                  {filteredCreditHistory.map(record => (
                    <div key={record.id} className="credit-history-item">
                      <div>
                        <strong>{record.reason}</strong>
                        <div className="credit-history-time">{formatCreditTime(record.createdAt)}</div>
                      </div>
                      <div className={record.delta >= 0 ? 'credit-delta plus' : 'credit-delta minus'}>
                        {record.delta >= 0 ? '+' : ''}{record.delta.toFixed(2)}
                      </div>
                      <div className="credit-balance-after">
                        Balance: {record.balanceAfter.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {currentUser.isAdmin && renderAdminUserManagement()}
            </div>
          )}
          {activeTab === 'account' && (
            <div className="publish">
              <h2>我的账号</h2>
              <p className="hint">管理你的登录密码与账号安全设置。</p>
              {renderSelfPasswordPanel()}
            </div>
          )}
          {activeTab === 'feedback' && (
            <div className="publish">
              <h2>意见反馈</h2>
              <p className="hint">欢迎分享你的想法、建议或报告问题。你的反馈对我们很重要！</p>
              <div className="feedback-form">
                <textarea
                  placeholder="请输入你的反馈内容（必填）"
                  value={feedbackContent}
                  onChange={(e) => setFeedbackContent(e.target.value)}
                  rows={5}
                />
                <div className="feedback-upload-section">
                  <label htmlFor="feedback-image" className="feedback-image-label">
                    添加图片（可选）
                  </label>
                  <input
                    id="feedback-image"
                    type="file"
                    accept="image/*"
                    onChange={handleFeedbackImageUpload}
                    style={{ display: 'none' }}
                  />
                  <button onClick={() => document.getElementById('feedback-image')?.click()} className="upload-image-btn">
                    选择图片
                  </button>
                  {feedbackImage && (
                    <div className="feedback-image-preview">
                      <img src={feedbackImage} alt="preview" />
                      <button onClick={() => setFeedbackImage(null)} className="remove-image-btn">移除图片</button>
                    </div>
                  )}
                </div>
                <button onClick={submitFeedback} className="submit-feedback-btn">提交反馈</button>
              </div>
            </div>
          )}
          {activeTab === 'admin' && currentUser.isAdmin && (
            <div className="publish">
              <h2>管理员控制台</h2>
              <p className="hint">你可以在这里管理用户权限、账号状态和用户反馈。</p>
              {renderTestingNoticePanel()}
              {renderAdminUserManagement()}
              {renderFeedbackManagement()}
            </div>
          )}
          {activeTab === 'truth' && (
            <>
              <div className="publish prediction-publish">
                <h2>发布一个预测</h2>
                <p className="hint">发布预测会消耗 {PREDICTION_PUBLISH_FEE} Crypo points。</p>
                <input
                  type="text"
                  placeholder="预测内容"
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                />
                <div className="prediction-meta-row">
                  <label>
                    我的预测内容属于哪个领域
                    <select value={newTag} onChange={(e) => setNewTag(e.target.value as '政治' | '经济' | '生活')}>
                      <option value="政治">政治</option>
                      <option value="经济">经济</option>
                      <option value="生活">生活</option>
                    </select>
                  </label>
                  <label>
                    验证预测的截止日期
                    <input
                      type="date"
                      value={newDeadline}
                      onChange={(e) => setNewDeadline(e.target.value)}
                    />
                  </label>
                </div>
                <div className="prediction-action-row">
                  <button disabled={Boolean(loadingState)} onClick={requestPublishMarket}>发布</button>
                </div>
              </div>
              <div className="market-toolbar">
                <div className="market-toolbar-group market-toolbar-group-keyword">
                  <label>
                    关键词搜索
                    <input
                      type="text"
                      placeholder="搜索预测内容或发布者"
                      value={marketKeyword}
                      onChange={(e) => setMarketKeyword(e.target.value)}
                    />
                  </label>
                </div>
                <div className="market-toolbar-group">
                  <label>
                    tag 检索
                    <select value={marketTagFilter} onChange={(e) => setMarketTagFilter(e.target.value as 'all' | '政治' | '经济' | '生活')}>
                      <option value="all">全部领域</option>
                      <option value="政治">政治</option>
                      <option value="经济">经济</option>
                      <option value="生活">生活</option>
                    </select>
                  </label>
                  <label>
                    预测截止时间
                    <select value={marketDeadlineFilter} onChange={(e) => setMarketDeadlineFilter(e.target.value as 'all' | 'upcoming' | 'soon' | 'expired')}>
                      <option value="all">全部</option>
                      <option value="upcoming">未截止</option>
                      <option value="soon">7 天内截止</option>
                      <option value="expired">已截止</option>
                    </select>
                  </label>
                  <label>
                    精确截止日期
                    <input
                      type="date"
                      value={marketDeadlineDate}
                      onChange={(e) => setMarketDeadlineDate(e.target.value)}
                    />
                  </label>
                  <label>
                    分类
                    <select value={marketScopeFilter} onChange={(e) => setMarketScopeFilter(e.target.value as 'all' | 'mine' | 'participated' | 'followed')}>
                      <option value="all">全部用户发布</option>
                      <option value="mine">我发布的</option>
                      <option value="participated">我参与过的</option>
                      <option value="followed">我关注的</option>
                    </select>
                  </label>
                  <button className="market-reset-btn" onClick={resetMarketFilters}>清空筛选</button>
                </div>
                <span className="market-count">当前显示 {filteredMarkets.length} 条预测</span>
              </div>
              {selectedMarket ? (
                <div className="market-detail">
                  <div className="market-detail-header">
                    <button className="market-back-btn" onClick={closeMarketDetail}>返回预测列表</button>
                  </div>
                  <h2>{selectedMarket.question}</h2>
                  <p>By: {selectedMarket.creator} | Tag: {selectedMarket.tag} | Deadline: {selectedMarket.deadline}</p>
                  <div className="detail-scoreline">
                    <span>会的：{selectedMarket.yesShares}</span>
                    <span>不会的：{selectedMarket.noShares}</span>
                    <span>参与用户：{selectedMarket.participants.length}</span>
                    <span>总投票记录：{selectedMarket.voteRecords.length}</span>
                    <span>状态：{selectedMarket.resolvedOutcome ? `已结算（${selectedMarket.resolvedOutcome === 'yes' ? '会的' : '不会的'}）` : '待结算'}</span>
                  </div>
                  {!selectedMarket.resolvedOutcome && new Date(selectedMarket.deadline).getTime() <= Date.now() && (
                    <div className="market-system-tip">
                      系统提示：预测已截止，需由发布者或管理员发布最终结果。
                    </div>
                  )}
                  {!selectedMarket.resolvedOutcome && new Date(selectedMarket.deadline).getTime() <= Date.now() && (currentUser.isAdmin || currentUser.name === selectedMarket.creator) && (
                    <div className="market-settle-row">
                      <span>截止时间已到，请确认最终结果：</span>
                      <button onClick={() => requestSettleMarket(selectedMarket, 'yes')}>确认结果：会的</button>
                      <button onClick={() => requestSettleMarket(selectedMarket, 'no')}>确认结果：不会的</button>
                    </div>
                  )}
                  {selectedMarket.resolvedOutcome && currentUser.isAdmin && (
                    <div className="market-settle-row">
                      <span>管理员可修改最终结果：</span>
                      <button onClick={() => requestSettleMarket(selectedMarket, 'yes')}>改为：会的</button>
                      <button onClick={() => requestSettleMarket(selectedMarket, 'no')}>改为：不会的</button>
                    </div>
                  )}
                  {selectedMarket.resolvedOutcome && (
                    <>
                      <h3>谁盈利了多少</h3>
                      {detailProfitLeaderboard.length === 0 ? (
                        <div className="secret-empty">暂无可结算的有效投票。</div>
                      ) : (
                        <div className="profit-leaderboard">
                          {detailProfitLeaderboard.map(item => (
                            <div key={item.user} className="profit-row">
                              <strong>{item.user}</strong>
                              <span>净盈利：{item.profit.toFixed(2)}</span>
                              <span>获得：{item.reward.toFixed(2)}</span>
                              <span>投入：{item.spent.toFixed(2)}</span>
                              <span>命中：{item.correctVotes}</span>
                              <span>失误：{item.wrongVotes}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <h3>用户投票统计</h3>
                  {detailVoteStats.length === 0 ? (
                    <div className="secret-empty">暂无投票记录。</div>
                  ) : (
                    <div className="vote-user-table">
                      {detailVoteStats.map(stat => (
                        <div key={stat.user} className="vote-user-row">
                          <strong>{stat.user}</strong>
                          <span>总计：{stat.total}</span>
                          <span>会的：{stat.yes}</span>
                          <span>不会的：{stat.no}</span>
                          <span>撤销：{stat.revoked}</span>
                          <span>最近投票：{formatVoteTime(stat.lastVoteAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <h3>投票时间线</h3>
                  {selectedMarket.voteRecords.length === 0 ? (
                    <div className="secret-empty">暂无投票记录。</div>
                  ) : (
                    <div className="vote-timeline">
                      {[...selectedMarket.voteRecords]
                        .sort((a, b) => b.createdAt - a.createdAt)
                        .map((record, index) => (
                          <div key={`${record.user}-${record.createdAt}-${index}`} className="vote-timeline-item">
                            <strong>{record.user}</strong>
                            <span>{record.outcome === 'yes' ? '会的' : '不会的'}</span>
                            <span>{record.status === 'revoked' ? '已撤销' : '有效票'}</span>
                            <span>{formatVoteTime(record.createdAt)}</span>
                            {record.revokedAt && <span>撤销时间：{formatVoteTime(record.revokedAt)}</span>}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
              {editingMarket && (
                <div className="edit">
                  <h2>Edit Market</h2>
                  <input
                    type="text"
                    value={editQuestion}
                    onChange={(e) => setEditQuestion(e.target.value)}
                  />
                  <input
                    type="date"
                    value={editDeadline}
                    onChange={(e) => setEditDeadline(e.target.value)}
                  />
                  <button onClick={saveEdit}>Save</button>
                  <button onClick={cancelEdit}>Cancel</button>
                </div>
              )}
              {filteredMarkets.map(market => (
                <div
                  key={market.id}
                  className={`market${new Date(market.deadline).getTime() <= Date.now() ? ' market-expired' : ''}`}
                >
                  <h2>
                    <a className="market-title-link" href={`#/prediction/${market.id}`} onClick={() => openMarketDetail(market.id)}>
                      {market.question}
                    </a>
                  </h2>
                  <div className="market-quick-actions">
                    <button className="market-follow-btn" onClick={() => toggleFollowMarket(market.id)}>
                      {market.followers.includes(currentUser.name) ? '取消关注' : '关注'}
                    </button>
                    {typeof market.pinnedAt === 'number' && <span className="market-pin-badge">置顶</span>}
                    <button className="market-pin-btn" onClick={() => togglePinMarket(market.id)}>
                      {typeof market.pinnedAt === 'number' ? '取消置顶' : '置顶'}
                    </button>
                  </div>
                  <p>By: {market.creator} | Tag: {market.tag} | Deadline: {market.deadline}</p>
                  {new Date(market.deadline).getTime() <= Date.now() && (
                    <p className="market-status-expired">{market.resolvedOutcome ? '已截止（已结算）' : '已截止，禁止继续投票'}</p>
                  )}
                  {!market.resolvedOutcome && new Date(market.deadline).getTime() <= Date.now() && (
                    <p className="market-system-tip">系统提示：结果需由发布者或管理员发布。</p>
                  )}
                  {market.resolvedOutcome ? (
                    <>
                      <p className="market-resolution">最终结果已确认：{market.resolvedOutcome === 'yes' ? '会的' : '不会的'}</p>
                      {currentUser.isAdmin && (
                        <div className="market-settle-row compact">
                          <span>管理员修改结果：</span>
                          <button onClick={() => requestSettleMarket(market, 'yes')}>改为会的</button>
                          <button onClick={() => requestSettleMarket(market, 'no')}>改为不会的</button>
                        </div>
                      )}
                    </>
                  ) : (new Date(market.deadline).getTime() <= Date.now() && (currentUser.isAdmin || currentUser.name === market.creator)) ? (
                    <div className="market-settle-row compact">
                      <span>截止后确认结果：</span>
                      <button onClick={() => requestSettleMarket(market, 'yes')}>会的</button>
                      <button onClick={() => requestSettleMarket(market, 'no')}>不会的</button>
                    </div>
                  ) : null}
                  {currentUser.isAdmin && (
                    <div>
                      <button onClick={() => startEdit(market)}>Edit</button>
                      <button onClick={() => deleteMarket(market.id)}>Delete</button>
                    </div>
                  )}
                  {new Date(market.deadline).getTime() > Date.now() && (
                    <div className="options">
                      <div className="option">
                        <button
                          disabled={Boolean(market.resolvedOutcome) || new Date(market.deadline).getTime() <= Date.now()}
                          onClick={() => requestBuyShare(market, 'yes')}
                        >
                          会的
                        </button>
                      </div>
                      <div className="option option-no">
                        <button
                          className="vote-no-btn"
                          disabled={Boolean(market.resolvedOutcome) || new Date(market.deadline).getTime() <= Date.now()}
                          onClick={() => requestBuyShare(market, 'no')}
                        >
                          不会的
                        </button>
                      </div>
                    </div>
                  )}
                  <p className="market-my-votes">
                    已有 {(market.yesShares + market.noShares).toFixed(2)} Crypo points 投入该预测
                  </p>
                  {new Date(market.deadline).getTime() <= Date.now() && currentUser && market.participants.includes(currentUser.name) && (
                    <div className="market-feedback-row">
                      <span>对于这个结果，你的感受是</span>
                      <button
                        className={market.resultFeedbacks.find(item => item.user === currentUser.name)?.stance === 'accept' ? 'feedback-btn selected' : 'feedback-btn'}
                        onClick={() => submitResultFeedback(market.id, 'accept')}
                      >
                        心服口服
                      </button>
                      <button
                        className={market.resultFeedbacks.find(item => item.user === currentUser.name)?.stance === 'verify' ? 'feedback-btn selected verify' : 'feedback-btn verify'}
                        onClick={() => submitResultFeedback(market.id, 'verify')}
                      >
                        我要验牌
                      </button>
                      <span className="market-feedback-count">
                        心服口服 {market.resultFeedbacks.filter(item => item.stance === 'accept').length} | 我要验牌 {market.resultFeedbacks.filter(item => item.stance === 'verify').length}
                      </span>
                    </div>
                  )}
                </div>
              ))}
              {filteredMarkets.length === 0 && (
                <div className="secret-empty">当前筛选条件下还没有预测。</div>
              )}
                </>
              )}
            </>
          )}
          {activeTab === 'secret' && (
            <>
              <div className="publish secret-publish">
                <h2>Share a Secret</h2>
                <p className="hint">发布会消耗 20 Crypo points，其他用户查看会支付积分给发布者。</p>
                <div className="publish-grid">
                  <input
                    type="text"
                    placeholder="Secret title"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                  />
                  <textarea
                    placeholder="Secret content"
                    value={newSecret}
                    onChange={(e) => setNewSecret(e.target.value)}
                    rows={4}
                  />
                  <label className="image-upload-field">
                    为秘密添加图片
                    <input type="file" accept="image/*" onChange={handleSecretImageChange} />
                  </label>
                  {newSecretImage && <img className="secret-upload-preview" src={newSecretImage} alt="Secret preview" />}
                  <div className="publish-row">
                    <span className="publish-price-note">小可爱们会为你的秘密支付</span>
                    <select value={newSecretPrice} onChange={(e) => setNewSecretPrice(Number(e.target.value))}>
                      <option value={1}>1 Crypo points</option>
                      <option value={2}>2 Crypo points</option>
                      <option value={5}>5 Crypo points</option>
                      <option value={10}>10 Crypo points</option>
                    </select>
                    <button className="share-btn" disabled={Boolean(loadingState)} onClick={requestShareSecret}>发布</button>
                  </div>
                </div>
              </div>
              <div className="secret-toolbar">
                <div className="secret-toolbar-group">
                  <label>
                    排序
                    <select value={secretSort} onChange={(e) => setSecretSort(e.target.value as 'latest' | 'oldest' | 'price-high' | 'price-low')}>
                      <option value="latest">最近发布</option>
                      <option value="oldest">最早发布</option>
                      <option value="price-high">价格从高到低</option>
                      <option value="price-low">价格从低到高</option>
                    </select>
                  </label>
                  <label>
                    筛选
                    <select value={secretTimeFilter} onChange={(e) => setSecretTimeFilter(e.target.value as 'all' | 'today' | 'week')}>
                      <option value="all">全部时间</option>
                      <option value="today">最近 24 小时</option>
                      <option value="week">最近 7 天</option>
                    </select>
                  </label>
                </div>
                <span className="secret-count">当前显示 {filteredSecrets.length} 条秘密</span>
              </div>
              {filteredSecrets.map(secret => {
                const myRating = secret.ratings.find(r => r.user === currentUser?.name);
                const realCount = secret.ratings.filter(r => r.authenticity === '真实').length;
                const fakeCount = secret.ratings.filter(r => r.authenticity === '不真实').length;
                const worthCount = secret.ratings.filter(r => r.value === '值得').length;
                const unworthCount = secret.ratings.filter(r => r.value === '不值得').length;

                return (
                  <div key={secret.id} className="secret">
                    <div className="secret-meta">
                      <h3>{secret.title}</h3>
                      <span>{formatSecretTime(secret.createdAt)}</span>
                    </div>
                    <div className="secret-scoreline">
                      <span>真实 {realCount}</span>
                      <span>不真实 {fakeCount}</span>
                      <span>值得 {worthCount}</span>
                      <span>不值得 {unworthCount}</span>
                    </div>
                    <p>By: {secret.author} | Price: {secret.price} Crypo points</p>
                    {currentUser?.isAdmin && (
                      <div className="secret-admin">
                        <button onClick={() => startEditSecret(secret)}>Edit</button>
                        <button onClick={() => deleteSecret(secret.id)}>Delete</button>
                      </div>
                    )}
                    {editingSecret?.id === secret.id ? (
                      <div className="secret-edit">
                        <input value={editSecretTitle} onChange={(e) => setEditSecretTitle(e.target.value)} />
                        <textarea value={editSecretContent} onChange={(e) => setEditSecretContent(e.target.value)} rows={3} />
                        <label className="image-upload-field">
                          替换秘密图片
                          <input type="file" accept="image/*" onChange={handleEditSecretImageChange} />
                        </label>
                        {editSecretImage && <img className="secret-upload-preview" src={editSecretImage} alt="Edited secret preview" />}
                        <select value={editSecretPrice} onChange={(e) => setEditSecretPrice(Number(e.target.value))}>
                          <option value={1}>1 Crypo points</option>
                          <option value={2}>2 Crypo points</option>
                          <option value={5}>5 Crypo points</option>
                          <option value={10}>10 Crypo points</option>
                        </select>
                        <button onClick={saveSecretEdit}>Save</button>
                        <button onClick={cancelSecretEdit}>Cancel</button>
                      </div>
                    ) : viewedSecrets.has(secret.id) ? (
                      <>
                        <p>{secret.content}</p>
                        {secret.imageUrl && <img className="secret-image" src={secret.imageUrl} alt={secret.title} />}
                        <div className="ratings ratings-facebook">
                          <div className="ratings-caption">看完这条秘密后，你的评价是</div>
                          <div className="ratings-actions">
                            <div className="ratings-group">
                              <button
                                className={`positive${myRating?.authenticity === '真实' ? ' selected' : ''}`}
                                onClick={() => rateSecret(secret.id, '真实', myRating?.value || '值得')}
                              >
                                真实
                              </button>
                              <button
                                className={`negative${myRating?.authenticity === '不真实' ? ' selected' : ''}`}
                                onClick={() => rateSecret(secret.id, '不真实', myRating?.value || '不值得')}
                              >
                                不真实
                              </button>
                            </div>
                            <div className="ratings-group">
                              <button
                                className={`positive${myRating?.value === '值得' ? ' selected' : ''}`}
                                onClick={() => rateSecret(secret.id, myRating?.authenticity || '真实', '值得')}
                              >
                                值得
                              </button>
                              <button
                                className={`negative${myRating?.value === '不值得' ? ' selected' : ''}`}
                                onClick={() => rateSecret(secret.id, myRating?.authenticity || '不真实', '不值得')}
                              >
                                不值得
                              </button>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <button onClick={() => requestViewSecret(secret)}>
                        {currentUser?.name === secret.author ? 'View (Free)' : `View for ${secret.price} Crypo points`}
                      </button>
                    )}
                  </div>
                );
              })}
              {filteredSecrets.length === 0 && (
                <div className="secret-empty">当前筛选条件下还没有秘密。</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default App
