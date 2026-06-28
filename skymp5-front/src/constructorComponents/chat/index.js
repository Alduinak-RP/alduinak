import React, { useState, useEffect, useRef, useCallback } from 'react';
import Draggable from 'react-draggable';
import { ResizableBox } from 'react-resizable';
import ChatCorner from '../../img/chat_corner.svg';
import Settings from './settings';
import ChatInput from './input';
import Channels, { DEFAULT_CHANNEL, SYSTEM_CHANNEL, applyChannel, channelForMessage } from './channels';
import { replaceIfMoreThan20 } from '../../utils/replaceIfMoreThan20';

import './styles.scss';
const MAX_LENGTH = 2000; // Max message length
const TIME_LIMIT = 1; // Seconds
const SHOUT_LIMIT = 180; // Seconds
const MAX_LINES = 10;
const MAX_SHOUT_LENGTH = 100;
const MAX_HISTORY_LENGTH = 20;

const SHOUTREGEXP = /№(.*?)№/gi;

const Chat = (props) => {
  const [input, updateInput] = useState('');
  const [isInputFocus, changeInputFocus] = useState(false);
  const [hideNonRP, changeNonRPHide] = useState(false);
  const [disableDiceSounds, setDisableDiceSounds] = useState(false);
  const [disableDiceColors, setDisableDiceColors] = useState(false);
  const [isPouchOpened, setPouchOpened] = useState(0);
  const [isSettingsOpened, setSettingsOpened] = useState(false);
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [fontSize, setFontSize] = useState(16);
  const placeholder = props.placeholder;
  const isInputHidden = props.isInputHidden;
  const send = props.send;
  const [lastSendInputText, setLastSendInputText] = useState(0);

  const [doesIncludeShout, setIncludeShout] = useState(false);

  const [shoutLength, setShoutLength] = useState(0);

  const inputRef = useRef();

  const chatRef = useRef();

  const isReset = useRef(true);

  const shoutReset = useRef(true);

  const messagesHistory = useRef([]);

  const currentMessageInHistory = useRef(-1);

  const writtenMessage = useRef('');
  
  // The System tab is a read-only feed of notifications — you can't type into it.
  const isSystemTab = channel === SYSTEM_CHANNEL;

  const hasUnreadPersonal = window.chatMessages.some((m) => m.channel === 'personal' && !m.read);
  const hasUnreadSystem = window.chatMessages.some((m) => m.channel === SYSTEM_CHANNEL && !m.read);
	useEffect(() => {
	  if (channel === 'personal') {
		window.chatMessages.forEach((m) => { if (m.channel === 'personal') m.read = true; });
	  }
	  if (channel === SYSTEM_CHANNEL) {
		window.chatMessages.forEach((m) => { if (m.channel === SYSTEM_CHANNEL) m.read = true; });
	  }
	}, [channel, props.messages]);

  const handleScroll = () => {
    if (chatRef.current) {
      window.needToScroll = (chatRef.current.scrollTop === chatRef.current.scrollHeight - chatRef.current.offsetHeight);
    }
  };

  const setEndOfContenteditable = (elem) => {
    const sel = window.getSelection();
    sel.selectAllChildren(elem);
    sel.collapseToEnd();
  };

  const addMessageToHistory = (message) => {
    messagesHistory.current = [message, ...messagesHistory.current];
    if (messagesHistory.length > MAX_HISTORY_LENGTH) {
      messagesHistory.current = messagesHistory.current.slice(0, MAX_HISTORY_LENGTH);
    }
    currentMessageInHistory.current = -1;
    writtenMessage.current = '';
  };

  const sendMessage = useCallback((text) => {
    if (channel === SYSTEM_CHANNEL) return;
    const shout = text.match(SHOUTREGEXP);
    const shoutLen = shout
      ? shout.reduce((acc, text) => {
        acc += text.length;
        return acc;
      }, 0)
      : 0;
    if (text !== '' && text.length <= MAX_LENGTH && isReset.current && shoutLen <= MAX_SHOUT_LENGTH && (shoutLen === 0 || shoutReset.current)) {
      if (send !== undefined) {
        const message = replaceIfMoreThan20(text.trim(), '\n', '', MAX_LINES);
        const applied = applyChannel(message, channel);
        send(applied);
        addMessageToHistory(message);
        // Follow the message into its tab (e.g. "/ooc hi" -> Global). 
        const target = channelForMessage(applied);
        if (target) setChannel(target);
      }
      isReset.current = false;
      updateInput('');
      inputRef.current.innerHTML = '';
      // Returns mouse to look after hitting send
      inputRef.current.blur();
      if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
        window.skyrimPlatform.sendMessage('cef::browser:unfocus');
      }
      if (shout) {
        shoutReset.current = false;
        setTimeout(() => {
          shoutReset.current = true;
        }, 1000 * SHOUT_LIMIT);
        setIncludeShout(false);
        setShoutLength(0);
      }
    }
  }, [send, updateInput, input, channel, isReset.current, shoutReset.current, shoutLength, doesIncludeShout]);

  useEffect(() => {
    window.needToScroll = true;
    const interval = setInterval(() => {
      isReset.current = true;
    }, 1000 * TIME_LIMIT);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const node = inputRef.current;
    const listener = (event) => {
      // Imitate message sending on Enter press
      if (event.code === 'Enter' && !event.shiftKey && inputRef.current) {
        event.preventDefault();
        sendMessage(input);
      }
      if (event.key === 'ArrowUp' && event.ctrlKey) {
        if (currentMessageInHistory.current === -1) {
          writtenMessage.current = input;
        }
        if (currentMessageInHistory.current + 1 < messagesHistory.current.length) {
          currentMessageInHistory.current = currentMessageInHistory.current + 1;
          updateInput(messagesHistory.current[currentMessageInHistory.current]);
          inputRef.current.innerHTML = messagesHistory.current[currentMessageInHistory.current];
          setEndOfContenteditable(inputRef.current);
        }
      }
      if (event.key === 'ArrowDown' && event.ctrlKey) {
        if (currentMessageInHistory.current >= 0) {
          if (currentMessageInHistory.current === 0) {
            updateInput(writtenMessage.current);
            inputRef.current.innerHTML = writtenMessage.current;
            setEndOfContenteditable(inputRef.current);
            currentMessageInHistory.current = -1;
          } else {
            currentMessageInHistory.current = currentMessageInHistory.current - 1;
            updateInput(messagesHistory.current[currentMessageInHistory.current]);
            inputRef.current.innerHTML = messagesHistory.current[currentMessageInHistory.current];
            setEndOfContenteditable(inputRef.current);
          }
        }
      }
    };
    node?.addEventListener('keydown', listener);
    return () => node?.removeEventListener('keydown', listener);
  }, [inputRef.current, input]);

  useEffect(() => {
    if (inputRef !== undefined && inputRef.current !== undefined && !isInputHidden) {
      inputRef.current.focus();
    }
  }, [isInputHidden]);

  // Behavior for T button (activate chat)
  useEffect(() => {
    const onBrowserFocused = () => {
      if (isInputHidden || isSystemTab) return;
      const el = inputRef.current;
      if (el) {
        el.focus();
        setEndOfContenteditable(el);
      }
    };
    window.addEventListener('skymp5-client:browserFocused', onBrowserFocused);
    return () => window.removeEventListener('skymp5-client:browserFocused', onBrowserFocused);
  }, [isInputHidden, isSystemTab]);

  useEffect(() => {
    const onUnfocused = () => setSettingsOpened(false);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, []);

  useEffect(() => {
    if (window.needToScroll) window.scrollToLastMessage();
    if (isInputFocus && inputRef !== undefined && inputRef.current !== undefined) {
      inputRef.current.focus();
    }
  }, [props.messages]);

  const handleInput = (value) => {
    updateInput(value);
    const shout = value.match(SHOUTREGEXP);
    if (shout && shout[0] !== '') {
      setIncludeShout(true);
      setShoutLength(shout.reduce((acc, text) => {
        acc += text.length;
        return acc;
      }, 0));
    } else {
      setIncludeShout(false);
      setShoutLength(0);
    }
  };

  const getMessageSpans = (message) => {
    let isNonRp = message.category === 'plain';
    const result = message.text.map(({ text, color, opacity, type }, i) => {
      if (i >= 1) {
        isNonRp = (type.includes('nonrp') && isNonRp);
      }
      return <span key={`${text}_${i}`} style={{ color: `${color}`, opacity: opacity }} className={`${type.join(' ')}`}>{text}</span>;
    });
    return [result, isNonRp];
  };

  const getList = () => {
    // Show only the active tab's messages; 'all' (server /system) shows everywhere.
    // Messages without a channel (legacy) fall back to Local.
    return window.chatMessages.filter((msg) => {
      const ch = msg.channel || 'local';
      return ch === channel || ch === 'all';
    }).map((msg, index) => {
        const result = getMessageSpans(msg);
        return (
          <div
            className={`msg ${result[1] ? 'nonrp' : ''}`}
            key={`msg-${index}`}
            style={{ marginLeft: '10px', opacity: msg.opacity }}
          >
            {result[0]}
          </div>
        );
      });
  };
  return (
    <div className='fullPage'>
      <Draggable handle='.chat-drag-bar' disabled={false} bounds={'.fullPage'}>
        <div id='chat'>
          <div className="chat-main">
            <div className='chat-header'>
              <div className='chat-drag-bar' title='Drag to move chat' />
            </div>
            <ResizableBox
              width={640}
              height={320}
              maxConstraints={[1000, 1100]}
              minConstraints={[320, 320]}
              axis={'both'}
              handle={
                 !isInputHidden &&
                 <div className='chat-corner'>
                   <img src={ChatCorner} />
                 </div>
              }
              resizeHandles={!isInputHidden ? ['se'] : []}
              className={`chat-resizable ${hideNonRP ? 'hideNonRP' : ''}`}
              id='handle'
            >
              <div className='chat-body'>
                <div className='chat-list' style={{ fontSize }} ref={chatRef} onScroll={(e) => handleScroll()}>
                  {getList()}
                </div>
                {
                  isInputHidden
                    ? <div style={{ height: '100px' }} />
                    : (
                      <div className='input'>
                        <Channels
                          active={channel}
                          unread={{ personal: hasUnreadPersonal, system: hasUnreadSystem }}
                          onSelect={(id) => {
                            setChannel(id);
                            if (id !== SYSTEM_CHANNEL && inputRef.current) inputRef.current.focus();
                          }}
                        />
                        <div className='chat-input'>
                          <ChatInput
                            id="chatInput"
                            className={'show'}
                            type="text"
                            readOnly={isSystemTab}
                            placeholder={isSystemTab ? 'System messages appear here' : (placeholder !== undefined ? placeholder : '')}
                            onChange={(value) => {
                              handleInput(value);
                              if (lastSendInputText + 1000 < Date.now()) {
                                window.skyrimPlatform.sendMessage('onInput');
                                setLastSendInputText(Date.now());
                              }
                            }}
                            onFocus={(e) => changeInputFocus(true)}
                            onBlur={(e) => changeInputFocus(false)}
                            ref={inputRef}
                            fontSize={fontSize}
                            maxLines={MAX_LINES}
                          />
                          <button
                            type='button'
                            className='chat-settings-button'
                            title='Settings'
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (inputRef.current && !isSystemTab) inputRef.current.focus();
                              setSettingsOpened((open) => !open);
                            }}
                          >
                            {'⚙ Settings'}
                          </button>
                        </div>
                        <div className='chat-checkboxes'>
                          { !isSystemTab && doesIncludeShout &&
                            <span className={`chat-message-limit shout-limit ${shoutLength > MAX_SHOUT_LENGTH ? 'limit' : ''} text`}>{shoutLength}/{MAX_SHOUT_LENGTH}</span>
                          }
                          { !isSystemTab &&
                            <span className={`chat-message-limit ${input.length > MAX_LENGTH ? 'limit' : ''} text`}>{input.length}/{MAX_LENGTH}</span>
                          }
                        </div>
                      </div>
                    )
                }
              </div>
            </ResizableBox>
          </div>
        </div>
      </Draggable>
      {
        (isSettingsOpened && !isInputHidden) &&
        <Settings
          fontSize={fontSize}
          setFontSize={setFontSize}
          isSoundsDisabled={disableDiceSounds}
          setDisableSounds={setDisableDiceSounds}
        />
      }
    </div>
  );
};

export default Chat;
