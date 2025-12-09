/**
 * Simple test to verify message reducer functionality
 */

import { createReducer, reducer } from './messageReducer';

// Test 1: Basic message processing
console.log('Test 1: Basic message processing');
const state1 = createReducer();
const rawMessages1 = [
  {
    _id: 'msg1',
    message_uuid: 'uuid1',
    role: 'user',
    content: 'Hello',
    timestamp: 1000,
  },
  {
    _id: 'msg2',
    message_uuid: 'uuid2',
    role: 'assistant',
    content: 'Hi there!',
    timestamp: 2000,
  },
];

const processed1 = reducer(state1, rawMessages1);
console.log('Processed messages:', processed1.length);
console.assert(processed1.length === 2, 'Should have 2 messages');
console.assert(processed1[0].role === 'user', 'First should be user');
console.assert(processed1[1].role === 'assistant', 'Second should be assistant');
console.log('✓ Test 1 passed');

// Test 2: Tool call lifecycle
console.log('\nTest 2: Tool call lifecycle');
const state2 = createReducer();
const rawMessages2 = [
  {
    _id: 'msg3',
    message_uuid: 'uuid3',
    role: 'assistant',
    content: 'Let me read that file',
    timestamp: 3000,
    tool_calls: [
      {
        id: 'tool1',
        name: 'Read',
        input: JSON.stringify({ file_path: '/test.txt' }),
      },
    ],
  },
  {
    _id: 'msg4',
    message_uuid: 'uuid4',
    role: 'user',
    timestamp: 4000,
    tool_results: [
      {
        tool_use_id: 'tool1',
        content: 'file contents here',
        is_error: false,
      },
    ],
  },
];

const processed2 = reducer(state2, rawMessages2);
console.log('Processed messages:', processed2.length);
console.assert(processed2.length === 2, 'Should have 2 messages (text + tool)');

const toolMessage = processed2.find((m) => m.tool);
console.assert(toolMessage !== undefined, 'Should have tool message');
console.assert(toolMessage!.tool!.state === 'completed', 'Tool should be completed');
console.assert(toolMessage!.tool!.result === 'file contents here', 'Should have result');
console.log('✓ Test 2 passed');

// Test 3: TodoWrite extraction
console.log('\nTest 3: TodoWrite extraction');
const state3 = createReducer();
const rawMessages3 = [
  {
    _id: 'msg5',
    message_uuid: 'uuid5',
    role: 'assistant',
    timestamp: 5000,
    tool_calls: [
      {
        id: 'tool2',
        name: 'TodoWrite',
        input: JSON.stringify({
          todos: [
            { content: 'Task 1', status: 'pending', activeForm: 'Task 1' },
            { content: 'Task 2', status: 'in_progress', activeForm: 'Task 2' },
          ],
        }),
      },
    ],
  },
];

reducer(state3, rawMessages3);
console.assert(state3.latestTodos !== undefined, 'Should have todos');
console.assert(state3.latestTodos!.todos.length === 2, 'Should have 2 todos');
console.log('✓ Test 3 passed');

// Test 4: Deduplication
console.log('\nTest 4: Deduplication');
const state4 = createReducer();
const rawMessages4 = [
  {
    _id: 'msg6',
    message_uuid: 'uuid6',
    role: 'user',
    content: 'Hello',
    timestamp: 6000,
  },
  {
    _id: 'msg7',
    message_uuid: 'uuid6', // Same UUID
    role: 'user',
    content: 'Hello',
    timestamp: 6000,
  },
];

const processed4 = reducer(state4, rawMessages4);
console.assert(processed4.length === 1, 'Should deduplicate by UUID');
console.log('✓ Test 4 passed');

// Test 5: Orphan tool result buffering (result arrives before tool call)
console.log('\nTest 5: Orphan tool result buffering');
const state5 = createReducer();

// First: tool result arrives BEFORE tool call
const rawMessages5a = [
  {
    _id: 'msg8',
    message_uuid: 'uuid8',
    role: 'user',
    timestamp: 7000,
    tool_results: [
      {
        tool_use_id: 'tool3',
        content: 'result from the future!',
        is_error: false,
      },
    ],
  },
];

const processed5a = reducer(state5, rawMessages5a);
console.assert(processed5a.length === 0, 'Should not create message for orphan result');
console.assert(state5.orphanToolResults.has('tool3'), 'Should buffer orphan result');

// Second: tool call arrives
const rawMessages5b = [
  {
    _id: 'msg9',
    message_uuid: 'uuid9',
    role: 'assistant',
    content: 'Reading file...',
    timestamp: 8000,
    tool_calls: [
      {
        id: 'tool3',
        name: 'Read',
        input: JSON.stringify({ file_path: '/test.txt' }),
      },
    ],
  },
];

const processed5b = reducer(state5, rawMessages5b);
console.assert(processed5b.length === 2, 'Should have text + tool messages');

const toolMessage5 = processed5b.find((m) => m.tool);
console.assert(toolMessage5 !== undefined, 'Should have tool message');
console.assert(toolMessage5!.tool!.state === 'completed', 'Tool should be completed immediately');
console.assert(
  toolMessage5!.tool!.result === 'result from the future!',
  'Should have orphan result'
);
console.assert(
  !state5.orphanToolResults.has('tool3'),
  'Should clean up orphan after processing'
);
console.log('✓ Test 5 passed');

console.log('\n✓ All tests passed!');
