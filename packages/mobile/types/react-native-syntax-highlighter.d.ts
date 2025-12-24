declare module 'react-native-syntax-highlighter' {
  import { ComponentType } from 'react';

  interface SyntaxHighlighterProps {
    language?: string;
    style?: any;
    customStyle?: any;
    fontSize?: number;
    children: string;
  }

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/styles/hljs' {
  export const atomOneDark: any;
}
