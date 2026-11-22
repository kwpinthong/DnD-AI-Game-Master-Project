import type { ScreenId } from '@isekai/protocol/contract';
import type { ReactNode } from 'react';
import { AdminDashboard } from '../AdminDashboard.tsx';
import { App } from '../App.tsx';
import { CharacterScreen } from '../CharacterScreen.tsx';
import { CreateGameForm } from '../CreateGameForm.tsx';
import { GmConsole } from '../GmConsole.tsx';
import { JoinForm } from '../JoinForm.tsx';
import { Lobby } from '../Lobby.tsx';
import { OriginCard } from '../OriginCard.tsx';
import { PlayRoom } from '../PlayRoom.tsx';
import { ScenarioEditor } from '../ScenarioEditor.tsx';
import { EndingPreview, LibraryPreview } from './previews.tsx';

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
const playRoom = ({ baseUrl, token }: FrameContext) => (
  <PlayRoom apiBaseUrl={baseUrl} token={token} onBack={noop} onNeedCharacter={noop} onSessionLost={noop} />
);
const PLAY: ScreenView = { page: 'PlayRoom', socket: true, render: playRoom };
const NONE: ScreenView = { page: '', socket: false, render: null };

export const SCREEN_VIEWS: Record<ScreenId, ScreenView> = {
  home: { page: 'App', socket: false, render: ({ baseUrl }) => <App apiBaseUrl={baseUrl} /> },
  join: { page: 'JoinForm', socket: false, render: ({ baseUrl }) => <JoinForm apiBaseUrl={baseUrl} onJoined={noop} /> },
  'create-game': { page: 'CreateGameForm', socket: false, render: ({ baseUrl }) => <CreateGameForm apiBaseUrl={baseUrl} onCreated={noop} onBack={noop} /> },
  'scenario-editor': {
    page: 'ScenarioEditor',
    socket: false,
    render: ({ baseUrl, token }) => <ScenarioEditor apiBaseUrl={baseUrl} token={token} onClose={noop} onSessionLost={noop} />,
  },
  lobby: { page: 'Lobby', socket: false, render: ({ baseUrl, token }) => <Lobby apiBaseUrl={baseUrl} token={token} onSessionLost={noop} /> },
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
  'play-self': PLAY,
  'play-companions': PLAY,
  'play-inventory': PLAY,
  'play-action': PLAY,
  'play-lock': PLAY,
  'play-astral': PLAY,
  'gm-console': { page: 'GmConsole', socket: false, render: ({ baseUrl, token }) => <GmConsole apiBaseUrl={baseUrl} token={token} refreshKey="mock" /> },
  ending: { page: 'GameLog (ตัวแทน)', socket: false, render: ({ baseUrl, token }) => <EndingPreview apiBaseUrl={baseUrl} token={token} /> },
  'ending-rating': NONE,
  'learning-library': { page: 'LibraryPreview (ตัวแทน)', socket: false, render: ({ baseUrl }) => <LibraryPreview apiBaseUrl={baseUrl} /> },
  'ai-usage': { page: 'AdminDashboard', socket: false, render: ({ baseUrl }) => <AdminDashboard apiBaseUrl={baseUrl} /> },
  'my-style': NONE,
};
