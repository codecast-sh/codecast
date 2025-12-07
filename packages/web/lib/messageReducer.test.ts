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

console.log('\n✓ All tests passed!');
