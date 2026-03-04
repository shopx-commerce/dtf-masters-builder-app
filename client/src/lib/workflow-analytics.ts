// Workflow Analytics and Personalization System
export interface UserAction {
  type: 'upload' | 'stroke_change' | 'resize_change' | 'shape_change' | 'download' | 'preview_zoom';
  timestamp: number;
  data: Record<string, any>;
  sessionId: string;
}

export interface WorkflowPattern {
  id: string;
  name: string;
  description: string;
  steps: string[];
  frequency: number;
  lastUsed: number;
  avgDuration: number;
  success_rate: number;
}

export interface WorkflowSuggestion {
  id: string;
  title: string;
  description: string;
  confidence: number;
  estimatedTime: string;
  benefits: string[];
  quickActions?: Array<{
    label: string;
    action: () => void;
  }>;
}

class WorkflowAnalytics {
  private actions: UserAction[] = [];
  private patterns: WorkflowPattern[] = [];
  private sessionId: string;
  private currentSession: UserAction[] = [];

  constructor() {
    this.sessionId = this.generateSessionId();
    this.loadStoredData();
    this.initializeDefaultPatterns();
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private loadStoredData() {
    try {
      const stored = localStorage.getItem('workflow_analytics');
      if (stored) {
        const data = JSON.parse(stored);
        this.actions = data.actions || [];
        this.patterns = data.patterns || [];
      }
    } catch (error) {
      console.error('Error loading workflow analytics:', error);
    }
  }

  private saveData() {
    try {
      localStorage.setItem('workflow_analytics', JSON.stringify({
        actions: this.actions.slice(-1000), // Keep last 1000 actions
        patterns: this.patterns
      }));
    } catch (error) {
      console.error('Error saving workflow analytics:', error);
    }
  }

  private initializeDefaultPatterns() {
    const defaultPatterns: WorkflowPattern[] = [
      {
        id: 'simple_outline',
        name: 'Simple Outline Creation',
        description: 'Upload image, enable contour, adjust width, download',
        steps: ['upload', 'enable_contour', 'adjust_width', 'download'],
        frequency: 0,
        lastUsed: 0,
        avgDuration: 120000, // 2 minutes
        success_rate: 0.95
      },
      {
        id: 'text_sticker',
        name: 'Text Sticker Workflow',
        description: 'Upload text image, enable auto text background, adjust size, download',
        steps: ['upload', 'auto_text_background', 'resize', 'download'],
        frequency: 0,
        lastUsed: 0,
        avgDuration: 90000, // 1.5 minutes
        success_rate: 0.92
      },
      {
        id: 'shape_background',
        name: 'Shape Background Design',
        description: 'Upload image, enable shape background, adjust shape, resize, download',
        steps: ['upload', 'enable_shape', 'adjust_shape', 'resize', 'download'],
        frequency: 0,
        lastUsed: 0,
        avgDuration: 180000, // 3 minutes
        success_rate: 0.88
      },
      {
        id: 'precise_cutout',
        name: 'Precise Cutout Creation',
        description: 'Upload image, enable contour with holes, fine-tune settings, download',
        steps: ['upload', 'enable_contour', 'include_holes', 'fine_tune', 'download'],
        frequency: 0,
        lastUsed: 0,
        avgDuration: 240000, // 4 minutes
        success_rate: 0.85
      }
    ];

    // Only add patterns that don't exist
    defaultPatterns.forEach(pattern => {
      if (!this.patterns.find(p => p.id === pattern.id)) {
        this.patterns.push(pattern);
      }
    });
  }

  trackAction(action: Omit<UserAction, 'timestamp' | 'sessionId'>) {
    const fullAction: UserAction = {
      ...action,
      timestamp: Date.now(),
      sessionId: this.sessionId
    };

    this.actions.push(fullAction);
    this.currentSession.push(fullAction);
    this.updatePatterns();
    this.saveData();
  }

  private updatePatterns() {
    // Analyze recent actions to update pattern frequencies
    const recentActions = this.actions.slice(-50);
    const sessionGroups = this.groupActionsBySession(recentActions);

    sessionGroups.forEach(session => {
      const matchedPattern = this.identifyPattern(session);
      if (matchedPattern) {
        const pattern = this.patterns.find(p => p.id === matchedPattern.id);
        if (pattern) {
          pattern.frequency += 1;
          pattern.lastUsed = Math.max(...session.map(a => a.timestamp));
          
          // Update success rate based on completion
          const isComplete = this.isSessionComplete(session);
          pattern.success_rate = (pattern.success_rate * 0.9) + (isComplete ? 0.1 : 0.05);
        }
      }
    });
  }

  private groupActionsBySession(actions: UserAction[]): UserAction[][] {
    const groups: Record<string, UserAction[]> = {};
    actions.forEach(action => {
      if (!groups[action.sessionId]) {
        groups[action.sessionId] = [];
      }
      groups[action.sessionId].push(action);
    });
    return Object.values(groups);
  }

  private identifyPattern(session: UserAction[]): WorkflowPattern | null {
    const actionTypes = session.map(a => a.type);
    
    // Simple pattern matching based on action sequences
    for (const pattern of this.patterns) {
      const matches = pattern.steps.filter(step => {
        switch (step) {
          case 'upload': return actionTypes.includes('upload');
          case 'enable_contour': return session.some(a => a.type === 'stroke_change' && a.data.enabled);
          case 'adjust_width': return session.some(a => a.type === 'stroke_change' && 'width' in a.data);
          case 'resize': return actionTypes.includes('resize_change');
          case 'download': return actionTypes.includes('download');
          case 'enable_shape': return session.some(a => a.type === 'shape_change' && a.data.enabled);
          case 'auto_text_background': return session.some(a => a.type === 'stroke_change' && a.data.autoTextBackground);
          case 'include_holes': return session.some(a => a.type === 'stroke_change' && a.data.includeHoles);
          default: return false;
        }
      });

      if (matches.length >= pattern.steps.length * 0.7) { // 70% match threshold
        return pattern;
      }
    }

    return null;
  }

  private isSessionComplete(session: UserAction[]): boolean {
    return session.some(a => a.type === 'download');
  }

  generateSuggestions(): WorkflowSuggestion[] {
    const suggestions: WorkflowSuggestion[] = [];
    const recentActions = this.currentSession.slice(-10);
    const hasUpload = recentActions.some(a => a.type === 'upload');

    if (!hasUpload) {
      suggestions.push({
        id: 'start_upload',
        title: 'Start Creating Your Sticker',
        description: 'Upload a PNG image to begin creating your custom sticker',
        confidence: 1.0,
        estimatedTime: '30 seconds',
        benefits: ['Quick start', 'Support for transparent backgrounds']
      });
      return suggestions;
    }

    // Analyze current session context
    const hasContour = recentActions.some(a => a.type === 'stroke_change' && a.data.enabled);
    const hasShape = recentActions.some(a => a.type === 'shape_change' && a.data.enabled);
    const hasDownload = recentActions.some(a => a.type === 'download');

    if (hasUpload && !hasContour && !hasShape) {
      suggestions.push({
        id: 'enable_outline',
        title: 'Add White Outline',
        description: 'Enable contour to create a cutting outline around your design',
        confidence: 0.9,
        estimatedTime: '15 seconds',
        benefits: ['Professional cutting lines', 'Better sticker durability']
      });

      suggestions.push({
        id: 'shape_background',
        title: 'Try Shape Background',
        description: 'Add a shape background for a different design style',
        confidence: 0.7,
        estimatedTime: '30 seconds',
        benefits: ['Uniform shape', 'Easy sizing']
      });
    }

    if (hasContour && !hasDownload) {
      const mostUsedPattern = this.getMostUsedPattern();
      if (mostUsedPattern && mostUsedPattern.success_rate > 0.8) {
        suggestions.push({
          id: 'follow_pattern',
          title: `Continue with ${mostUsedPattern.name}`,
          description: mostUsedPattern.description,
          confidence: mostUsedPattern.success_rate,
          estimatedTime: this.formatDuration(mostUsedPattern.avgDuration),
          benefits: ['Proven workflow', 'High success rate']
        });
      }

      suggestions.push({
        id: 'download_ready',
        title: 'Download Your Sticker',
        description: 'Your design looks ready! Download as PNG with cutlines',
        confidence: 0.8,
        estimatedTime: '10 seconds',
        benefits: ['Cutting machine ready', 'High quality output']
      });
    }

    // Time-based suggestions
    const sessionDuration = Date.now() - (this.currentSession[0]?.timestamp || Date.now());
    if (sessionDuration > 300000 && !hasDownload) { // 5 minutes
      suggestions.push({
        id: 'quick_finish',
        title: 'Quick Finish Options',
        description: 'Complete your design with these quick settings',
        confidence: 0.6,
        estimatedTime: '30 seconds',
        benefits: ['Save time', 'Good results']
      });
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private getMostUsedPattern(): WorkflowPattern | null {
    if (this.patterns.length === 0) return null;
    return this.patterns.reduce((max, pattern) => 
      pattern.frequency > max.frequency ? pattern : max
    );
  }

  private formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }

  getUserInsights() {
    const totalSessions = new Set(this.actions.map(a => a.sessionId)).size;
    const completedSessions = this.groupActionsBySession(this.actions)
      .filter(session => this.isSessionComplete(session)).length;
    
    const avgSessionDuration = this.calculateAverageSessionDuration();
    const mostCommonActions = this.getMostCommonActions();
    const preferredSettings = this.getPreferredSettings();

    return {
      totalSessions,
      completedSessions,
      completionRate: totalSessions > 0 ? completedSessions / totalSessions : 0,
      avgSessionDuration: this.formatDuration(avgSessionDuration),
      mostCommonActions,
      preferredSettings,
      suggestions: this.generateSuggestions()
    };
  }

  private calculateAverageSessionDuration(): number {
    const sessions = this.groupActionsBySession(this.actions);
    const durations = sessions.map(session => {
      if (session.length < 2) return 0;
      return Math.max(...session.map(a => a.timestamp)) - Math.min(...session.map(a => a.timestamp));
    }).filter(d => d > 0);

    return durations.length > 0 ? durations.reduce((a, b) => a + b) / durations.length : 0;
  }

  private getMostCommonActions(): Array<{action: string, count: number}> {
    const actionCounts: Record<string, number> = {};
    this.actions.forEach(action => {
      actionCounts[action.type] = (actionCounts[action.type] || 0) + 1;
    });

    return Object.entries(actionCounts)
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  private getPreferredSettings() {
    const strokeChanges = this.actions.filter(a => a.type === 'stroke_change');
    const resizeChanges = this.actions.filter(a => a.type === 'resize_change');

    const avgStrokeWidth = strokeChanges.length > 0 
      ? strokeChanges.reduce((sum, a) => sum + (a.data.width || 0), 0) / strokeChanges.length 
      : 0;

    const commonColor = this.getMostCommonValue(strokeChanges, 'color') || '#ffffff';
    
    return {
      strokeWidth: Math.round(avgStrokeWidth),
      strokeColor: commonColor,
      usesAutoTextBackground: strokeChanges.some(a => a.data.autoTextBackground),
      usesShapeBackground: this.actions.some(a => a.type === 'shape_change' && a.data.enabled),
      usesHoles: strokeChanges.some(a => a.data.includeHoles)
    };
  }

  private getMostCommonValue(actions: UserAction[], key: string): any {
    const values: Record<string, number> = {};
    actions.forEach(action => {
      if (key in action.data) {
        const value = String(action.data[key]);
        values[value] = (values[value] || 0) + 1;
      }
    });

    const entries = Object.entries(values);
    return entries.length > 0 
      ? entries.reduce((max, curr) => curr[1] > max[1] ? curr : max)[0]
      : null;
  }

  resetSession() {
    this.sessionId = this.generateSessionId();
    this.currentSession = [];
  }
}

export const workflowAnalytics = new WorkflowAnalytics();