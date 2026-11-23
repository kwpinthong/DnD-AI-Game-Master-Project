import type { ScreenId } from '@isekai/protocol/contract';
import { useState, type ReactNode } from 'react';
import { AdminDashboard } from '../AdminDashboard.tsx';
import { AdminGames } from '../AdminGames.tsx';
import { GameClosedModal, type GameClosure } from '../GameClosed.tsx';
import { App } from '../App.tsx';
import { CharacterScreen } from '../CharacterScreen.tsx';
import { CreateGameForm } from '../CreateGameForm.tsx';
import { GameSummaryPage } from '../GameHistory.tsx';
import { JoinForm } from '../JoinForm.tsx';
import { LearningLibrary } from '../LearningLibrary.tsx';
import { GameDataEditor } from '../GameDataEditor.tsx';
import { Lobby } from '../Lobby.tsx';
import { MyStyle } from '../MyStyle.tsx';
import { OriginCard } from '../OriginCard.tsx';
import { PlayRoom } from '../PlayRoom.tsx';
import { ScenarioEditor } from '../ScenarioEditor.tsx';
import { VoteReview } from '../VoteReview.tsx';
import { GmConsoleFrame } from './previews.tsx';

/**
 * What the gallery renders for each contract screen (GEN-100): the page that exists today (pre-v2) or a
 * stand-in, or null = no page yet. When GEN-088..091 build a screen they change its entry here.
 */
export interface FrameContext {
  baseUrl: string;
  token: string;
}

export interface ScreenView {
  /** The component shown, as the code names it. */
  page: string;
  /** It talks to the play-room socket: the frame gets the simulate buttons. */
  socket: boolean;
  render: ((ctx: FrameContext) => ReactNode) | null;
}

const noop = () => {};

/** ISK-002: in the app the lobby shows the close; here the frame does, kept inside it (`gallery-inline`). */
function PlayFrame({ baseUrl, token }: FrameContext) {
  const [closed, setClosed] = useState<GameClosure | null>(null);
  if (closed) {
    return (
      <div className="gallery-inline">
        <GameClosedModal closed={closed} onSummary={noop} onHome={noop} />
      </div>
    );
  }
  return <PlayRoom apiBaseUrl={baseUrl} token={token} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} onClosed={setClosed} />;
}
const playRoom = (ctx: FrameContext) => <PlayFrame {...ctx} />;
const PLAY: ScreenView = { page: 'PlayRoom', socket: true, render: playRoom };
/** The end page (GEN-091): the reveal and the rating are two parts of the same page. */
const END: ScreenView = {
  page: 'GameSummaryPage',
  socket: false,
  render: ({ baseUrl, token }) => (
    <div className="preview">
      <GameSummaryPage apiBaseUrl={baseUrl} token={token} onBack={noop} />
    </div>
  ),
};
/** The mock admin routes answer any token; the real page gets one from the admin code (AdminDashboard). */
const MOCK_ADMIN_TOKEN = 'mock-admin';

export const SCREEN_VIEWS: Record<ScreenId, ScreenView> = {
  home: { page: 'App', socket: false, render: ({ baseUrl }) => <App apiBaseUrl={baseUrl} /> },
  join: { page: 'JoinForm', socket: false, render: ({ baseUrl }) => <JoinForm apiBaseUrl={baseUrl} onJoined={noop} /> },
  'create-game': { page: 'CreateGameForm', socket: false, render: ({ baseUrl }) => <CreateGameForm apiBaseUrl={baseUrl} onCreated={noop} onBack={noop} /> },
  'scenario-editor': {
    page: 'ScenarioEditor',
    socket: false,
    render: ({ baseUrl, token }) => <ScenarioEditor apiBaseUrl={baseUrl} token={token} onClose={noop} onSessionLost={noop} />,
  },
  lobby: {
    page: 'Lobby',
    socket: false,
    // `gallery-inline` keeps a closed game's modal (ISK-002) inside the frame
    render: ({ baseUrl, token }) => (
      <div className="gallery-inline">
        <Lobby apiBaseUrl={baseUrl} token={token} onSessionLost={noop} />
      </div>
    ),
  },
  character: {
    page: 'CharacterScreen',
    socket: false,
    render: ({ baseUrl, token }) => <CharacterScreen apiBaseUrl={baseUrl} token={token} onBack={noop} onSessionLost={noop} />,
  },
  'origin-card': {
    page: 'OriginCard',
    socket: false,
    // `origin-inline` keeps the card's fixed veil inside the frame
    render: ({ baseUrl, token }) => (
      <div className="origin-inline">
        <OriginCard apiBaseUrl={baseUrl} token={token} onClose={noop} />
      </div>
    ),
  },
  'play-top-bar': PLAY,
  'play-place': PLAY,
  'play-feed': PLAY,
  'play-private': PLAY,
  'play-hit': PLAY,
  'play-changes': PLAY,
  'play-npc': PLAY,
  'play-self': PLAY,
  'play-companions': PLAY,
  'play-inventory': PLAY,
  'play-action': PLAY,
  'play-lock': PLAY,
  'play-astral': PLAY,
  'gm-console': {
    page: 'GmConsole',
    socket: false,
    render: ({ baseUrl, token }) => (
      <div className="preview">
        <GmConsoleFrame apiBaseUrl={baseUrl} token={token} />
      </div>
    ),
  },
  ending: END,
  'ending-rating': END,
  'learning-library': {
    page: 'LearningLibrary',
    socket: false,
    render: ({ baseUrl }) => (
      <div className="preview">
        <LearningLibrary apiBaseUrl={baseUrl} token={MOCK_ADMIN_TOKEN} onForbidden={noop} />
      </div>
    ),
  },
  'ai-usage': { page: 'AdminDashboard', socket: false, render: ({ baseUrl }) => <AdminDashboard apiBaseUrl={baseUrl} /> },
  'my-style': { page: 'MyStyle', socket: false, render: ({ baseUrl }) => <MyStyle apiBaseUrl={baseUrl} /> },
  'game-data': {
    page: 'GameDataEditor',
    socket: false,
    render: ({ baseUrl }) => (
      <div className="preview">
        <GameDataEditor apiBaseUrl={baseUrl} token={MOCK_ADMIN_TOKEN} onForbidden={noop} />
      </div>
    ),
  },
  // GEN-168
  'vote-review': {
    page: 'VoteReview',
    socket: false,
    render: ({ baseUrl }) => (
      <div className="preview">
        <VoteReview apiBaseUrl={baseUrl} token={MOCK_ADMIN_TOKEN} onForbidden={noop} />
      </div>
    ),
  },
  // ISK-002: the close dialog stays inside the frame (`gallery-inline`).
  'admin-games': {
    page: 'AdminGames',
    socket: false,
    render: ({ baseUrl }) => (
      <div className="preview gallery-inline">
        <AdminGames apiBaseUrl={baseUrl} token={MOCK_ADMIN_TOKEN} onForbidden={noop} />
      </div>
    ),
  },
};
